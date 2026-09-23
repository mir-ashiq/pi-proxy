/**
 * Pi Proxy Server — request routing & forwarding.
 *
 * This module is the routing layer of the proxy. It does NOT hardcode
 * any upstream — instead it reads provider configs from Pi's
 * `~/.pi/agent/models.json` (via `@/lib/pi-config`) and routes each
 * incoming request to the right provider based on the requested model.
 *
 * Flow:
 *   1. Client POSTs to /api/v1/chat/completions (OpenAI) or
 *      /api/v1/messages (Anthropic).
 *   2. The route handler extracts `model` from the body.
 *   3. `findProviderForModel(model, clientFormat)` returns the provider
 *      that serves that model (preferring one whose wire format matches
 *      the client's, to avoid unnecessary conversion).
 *   4. If the provider's format differs from the client's, the
 *      format-converter translates the request body.
 *   5. The proxy forwards to the provider's `baseUrl` with the provider's
 *      resolved `apiKey`.
 *   6. The response (streaming or not) is converted back to the client's
 *      format and piped to the caller.
 *
 * Demo mode: if `PI_DEMO_MODE=1` or the request includes `x-pi-demo: 1`,
 * the proxy returns simulated SSE responses without contacting any
 * upstream. Useful when no providers are configured or when all
 * upstreams are unreachable (e.g. behind a WAF).
 */

import {
  type PiProvider,
  type WireFormat,
  apiFormatToWireFormat,
  findProviderForModel,
  loadPiConfig,
  maskApiKey,
} from "@/lib/pi-config";
import {
  conversionNeeded,
  convertRequestBody,
  convertResponseBody,
  convertStreamResponse,
} from "@/lib/format-converter";
import { platform as osPlatform, release as osRelease, arch as osArch } from "node:os";

export const PI_PROXY_VERSION = "2.0.0";

/** Demo mode: when true, return simulated responses without hitting upstreams. */
export const DEMO_MODE =
  process.env.PI_DEMO_MODE === "1" || process.env.PI_DEMO_MODE === "true";

/** Returns true if the request should be served in demo mode. */
export function shouldUseDemo(req: Request): boolean {
  if (DEMO_MODE) return true;
  const h = req.headers.get("x-pi-demo");
  return h === "1" || h === "true";
}

/** Detect a `stream: true` flag in either format's request body. */
export function isStreamRequest(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const v = (body as { stream?: unknown }).stream;
  return v === true || v === "true";
}

/** Build an OpenAI-format error envelope. */
export function openAIError(
  status: number,
  message: string,
  type = "api_error",
  code?: string,
): Response {
  return new Response(
    JSON.stringify({
      error: { message, type, code: code ?? null, status },
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "X-Pi-Proxy": PI_PROXY_VERSION,
      },
    },
  );
}

/** Build an Anthropic-format error envelope. */
export function anthropicError(
  status: number,
  message: string,
  type = "api_error",
): Response {
  return new Response(
    JSON.stringify({
      type: "error",
      error: { type, message },
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "X-Pi-Proxy": PI_PROXY_VERSION,
      },
    },
  );
}

/**
 * Build a Pi-style User-Agent string that matches what the Pi CLI
 * itself sends when calling upstreams.
 *
 * Pi's getPiUserAgent() returns:
 *   `pi (<platform> <release>; <arch>)`
 * e.g. `pi (linux 6.5.0; x64)`
 *
 * AgentRouter (and possibly other providers) whitelist the `pi (...)`
 * User-Agent prefix. If the proxy sends a generic User-Agent (curl/x.x,
 * node-fetch/x.x, etc.) the upstream rejects with "unauthorized client".
 *
 * We replicate Pi's User-Agent so the proxy looks like a legitimate Pi
 * client to the upstream.
 */
function buildPiUserAgent(): string {
  const platformStr = osPlatform() || (process.platform || "linux");
  const releaseStr = osRelease() || "";
  const archStr = osArch() || (process.arch || "x64");
  return `pi (${platformStr} ${releaseStr}; ${archStr})`;
}

/**
 * Build upstream fetch headers for a given provider + format.
 *
 * Forwards the client's headers (so that any headers the SDK/pi sends
 * that the upstream might require — X-Stainless-*, anthropic-beta, etc.
 * — get through), then OVERRIDES the auth headers with the provider's
 * resolved API key and the User-Agent with Pi's User-Agent.
 *
 * Headers that are always set by the proxy (not forwarded):
 *   - Authorization / x-api-key  (provider's key)
 *   - Content-Type               (always JSON)
 *   - User-Agent                 (Pi-style, to pass client fingerprinting)
 *   - Cookie                     (provider's cookie, if any)
 *
 * Headers that ARE forwarded from the client:
 *   - X-Stainless-* (OpenAI SDK telemetry)
 *   - anthropic-version, anthropic-beta
 *   - Accept, Accept-Language, Accept-Encoding
 *   - Any other custom headers the client sends
 */
function buildUpstreamHeaders(
  provider: PiProvider,
  format: WireFormat,
  clientHeaders: Headers,
): Headers {
  // Start by copying ALL of the client's headers.
  const h = new Headers(clientHeaders);

  // Force JSON content type.
  h.set("Content-Type", "application/json");
  h.set("Accept", "application/json, text/event-stream");

  // Remove client-side auth headers — we replace them with the
  // provider's key so the client never needs to know the real key.
  h.delete("authorization");
  h.delete("x-api-key");
  h.delete("api-key");
  // Remove proxy-internal headers that shouldn't leak upstream.
  h.delete("x-pi-demo");
  h.delete("host");
  h.delete("content-length"); // fetch will recompute this

  // Set the provider's auth header based on the upstream's wire format.
  if (format === "anthropic") {
    h.set("x-api-key", provider.apiKey);
    // Ensure anthropic-version is present (use client's if they sent one).
    if (!h.has("anthropic-version")) {
      h.set("anthropic-version", "2023-06-01");
    }
  } else {
    h.set("Authorization", `Bearer ${provider.apiKey}`);
  }

  // Override User-Agent with Pi's User-Agent so the upstream sees a
  // legitimate Pi client. This is critical for AgentRouter and any
  // other provider that does client fingerprinting on User-Agent.
  h.set("User-Agent", buildPiUserAgent());

  // Override cookie with the provider's cookie if configured.
  if (provider.cookie) {
    h.set("Cookie", provider.cookie);
  }

  return h;
}

/** Build the upstream URL for a given provider + format.
 *
 * Preserves query parameters from the client's request URL (e.g.
 * `?beta=true` that pi sends on Anthropic-format requests).
 */
function buildUpstreamUrl(
  provider: PiProvider,
  format: WireFormat,
  clientUrl?: URL,
): string {
  const base = provider.baseUrl.replace(/\/+$/, "");
  let path: string;
  if (format === "openai") {
    // OpenAI upstreams expect POST {base}/chat/completions
    // If baseUrl already ends with /v1, we just append /chat/completions.
    path = base.endsWith("/v1") ? "/chat/completions" : "/v1/chat/completions";
  } else {
    // Anthropic upstreams expect POST {base}/v1/messages
    path = base.endsWith("/v1") ? "/messages" : "/v1/messages";
  }

  // Forward query params from the client's request (e.g. ?beta=true).
  let query = "";
  if (clientUrl && clientUrl.search) {
    query = clientUrl.search; // already includes the leading "?"
  }

  return `${base}${path}${query}`;
}

/** Detect an Aliyun WAF challenge response (returns hint or null). */
function detectWafChallenge(
  upstream: Response,
  bodyText: string,
  providerName?: string,
): string | null {
  const ct = upstream.headers.get("content-type") || "";
  if (!ct.includes("text/html") || !bodyText) return null;
  if (
    bodyText.includes("aliyun_waf_aa") ||
    bodyText.includes("initAliyunCaptcha") ||
    bodyText.includes("CF_APP_WAF")
  ) {
    return (
      `Upstream provider${providerName ? ` "${providerName}"` : ""} returned ` +
      `an Aliyun WAF slider-captcha challenge. Server-to-server fetches ` +
      `cannot pass this automatically. Add a "cookie" field to that ` +
      `provider in ~/.pi/agent/models.json with the acw_tc cookie from ` +
      `your browser session, or set PI_UPSTREAM_COOKIE_<ProviderName> ` +
      `in .env.`
    );
  }
  return null;
}

export interface RouteResult {
  response: Response;
  /** Provider used (for logging/headers). */
  provider?: PiProvider;
  /** Whether format conversion was applied. */
  conversion: "none" | "openai→anthropic" | "anthropic→openai";
}

/**
 * Route and forward a request to the matching upstream provider.
 *
 * `clientFormat` is the wire format the client used (openai or anthropic).
 * `body` is the parsed request body. `req` is the original Request (for
 * demo-mode detection and header forwarding).
 *
 * Returns a RouteResult with the Response to return to the client.
 */
export async function routeAndForward(
  req: Request,
  body: unknown,
  clientFormat: WireFormat,
): Promise<RouteResult> {
  const model =
    typeof (body as { model?: unknown })?.model === "string"
      ? ((body as { model: string }).model)
      : "";

  // Demo mode short-circuits everything.
  if (shouldUseDemo(req)) {
    return {
      response: demoResponse(model, body, clientFormat),
      conversion: "none",
    };
  }

  if (!model) {
    return {
      response:
        clientFormat === "openai"
          ? openAIError(400, "Request body must include a `model` field.")
          : anthropicError(400, "Request body must include a `model` field."),
      conversion: "none",
    };
  }

  const provider = findProviderForModel(model, clientFormat);
  if (!provider) {
    const cfg = loadPiConfig();
    const hint =
      cfg.providers.length === 0
        ? "No providers are configured in ~/.pi/agent/models.json. " +
          "Add a provider first, or enable demo mode with x-pi-demo: 1."
        : `Model "${model}" is not listed in any configured provider. ` +
          `Available models: ${cfg.providers
            .flatMap((p) => p.models.map((m) => m.id))
            .filter((v, i, a) => a.indexOf(v) === i)
            .slice(0, 20)
            .join(", ")}`;
    return {
      response:
        clientFormat === "openai"
          ? openAIError(404, hint, "invalid_request_error", "MODEL_NOT_FOUND")
          : anthropicError(404, hint, "not_found_error"),
      conversion: "none",
    };
  }

  const providerFormat = apiFormatToWireFormat(provider.api);
  const conversion = conversionNeeded(clientFormat, providerFormat);
  const stream = isStreamRequest(body);

  // Convert request body if needed.
  const upstreamBody = convertRequestBody(body, conversion);

  // Parse the client's URL to forward query params (e.g. ?beta=true).
  const clientUrl = (() => {
    try {
      return new URL(req.url);
    } catch {
      return undefined;
    }
  })();

  const url = buildUpstreamUrl(provider, providerFormat, clientUrl);
  const headers = buildUpstreamHeaders(
    provider,
    providerFormat,
    new Headers(req.headers),
  );

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamBody),
      signal: stream ? undefined : AbortSignal.timeout(120_000),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      response:
        clientFormat === "openai"
          ? openAIError(502, `upstream fetch failed: ${msg}`, "upstream_error")
          : anthropicError(502, `upstream fetch failed: ${msg}`, "upstream_error"),
      conversion: "none",
      provider,
    };
  }

  // Detect WAF challenge on HTML responses.
  if (upstream.headers.get("content-type")?.includes("text/html")) {
    const sample = await upstream.text().catch(() => "");
    const waf = detectWafChallenge(upstream, sample, provider.name);
    if (waf) {
      return {
        response:
          clientFormat === "openai"
            ? openAIError(502, waf, "upstream_waf_challenge", "WAF_CHALLENGE")
            : anthropicError(502, waf, "upstream_waf_challenge"),
        conversion: "none",
        provider,
      };
    }
    return {
      response:
        clientFormat === "openai"
          ? openAIError(
              502,
              `upstream returned HTML instead of JSON (status ${upstream.status}). First 200 chars: ${sample.slice(0, 200)}`,
              "upstream_error",
            )
          : anthropicError(
              502,
              `upstream returned HTML instead of JSON (status ${upstream.status}). First 200 chars: ${sample.slice(0, 200)}`,
              "upstream_error",
            ),
      conversion: "none",
      provider,
    };
  }

  // Handle upstream HTTP errors.
  //
  // KEY DESIGN DECISION: the proxy is TRANSPARENT on errors. If the
  // upstream returns a JSON error body (e.g.
  //   {"error":{"message":"unauthorized client","type":"..."}}
  // or
  //   {"type":"error","error":{"type":"authentication_error","message":"..."}}
  // ), the proxy forwards that JSON body AS-IS to the client, preserving
  // the upstream's status code. This way the client sees the real error
  // message from the upstream, not a double-wrapped proxy error.
  //
  // Only when the upstream returns a non-JSON body do we wrap it in our
  // own error envelope.
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    const ct = upstream.headers.get("content-type") || "";

    // Try to parse as JSON — if it succeeds, forward it verbatim.
    let parsed: unknown = null;
    if (text && (ct.includes("application/json") || text.trim().startsWith("{"))) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // Not valid JSON — fall through to wrapping below.
      }
    }

    if (parsed !== null) {
      // Forward the upstream's JSON error body as-is, preserving status.
      if (stream) {
        // For streaming, emit the error as an SSE event in the client's
        // expected format. If the upstream's error is already in the
        // client's format (no conversion needed), forward verbatim.
        // Otherwise wrap in the client's format.
        let sseData: string;
        if (conversion === "none") {
          // Same format — forward the upstream's JSON error as-is.
          sseData = text;
        } else if (clientFormat === "openai") {
          // Upstream is Anthropic, client wants OpenAI. Convert error.
          const anthErr = parsed as { error?: { message?: string; type?: string } };
          sseData = JSON.stringify({
            error: {
              message: anthErr?.error?.message || text,
              type: anthErr?.error?.type || "upstream_error",
              code: upstream.status,
            },
          });
        } else {
          // Upstream is OpenAI, client wants Anthropic. Convert error.
          const oaiErr = parsed as { error?: { message?: string; type?: string } };
          sseData = JSON.stringify({
            type: "error",
            error: {
              type: oaiErr?.error?.type || "upstream_error",
              message: oaiErr?.error?.message || text,
            },
          });
        }
        const sse = `data: ${sseData}\n\ndata: [DONE]\n\n`;
        return {
          response: new Response(sse, {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache, no-transform",
              Connection: "keep-alive",
            },
          }),
          conversion: "none",
          provider,
        };
      }
      // Non-streaming: forward the upstream's JSON error as-is.
      // If conversion is needed, convert the error body.
      let bodyToReturn = parsed;
      if (conversion !== "none") {
        // Extract the message from whichever format the upstream used,
        // and re-wrap in the client's expected format.
        const errMsg =
          (parsed as { error?: { message?: string } })?.error?.message ||
          text;
        if (clientFormat === "openai") {
          bodyToReturn = {
            error: {
              message: errMsg,
              type: "upstream_error",
              code: upstream.status,
            },
          };
        } else {
          bodyToReturn = {
            type: "error",
            error: {
              type: "upstream_error",
              message: errMsg,
            },
          };
        }
      }
      return {
        response: new Response(JSON.stringify(bodyToReturn), {
          status: upstream.status,
          headers: {
            "Content-Type": "application/json",
            "X-Pi-Proxy": PI_PROXY_VERSION,
            "X-Pi-Proxy-Provider": provider.name,
            "X-Pi-Proxy-Conversion": conversion,
          },
        }),
        conversion: "none",
        provider,
      };
    }

    // Non-JSON error body — wrap in our own error envelope.
    const fallbackMsg = text || `upstream returned ${upstream.status}`;
    if (stream) {
      if (clientFormat === "openai") {
        const errorBody = JSON.stringify({
          error: {
            message: fallbackMsg,
            type: "upstream_error",
            code: upstream.status,
          },
        });
        return {
          response: new Response(
            `data: ${errorBody}\n\ndata: [DONE]\n\n`,
            {
              status: 200,
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
              },
            },
          ),
          conversion: "none",
          provider,
        };
      }
      const errorPayload = JSON.stringify({
        type: "error",
        error: {
          type: "upstream_error",
          message: fallbackMsg,
        },
      });
      return {
        response: new Response(`event: error\ndata: ${errorPayload}\n\n`, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
          },
        }),
        conversion: "none",
        provider,
      };
    }
    return {
      response:
        clientFormat === "openai"
          ? openAIError(upstream.status, fallbackMsg, "upstream_error")
          : anthropicError(upstream.status, fallbackMsg, "upstream_error"),
      conversion: "none",
      provider,
    };
  }

  // Success: convert response if needed.
  if (stream) {
    // Streaming: wrap the upstream body with a format-converting TransformStream.
    const converted = convertStreamResponse(upstream, conversion, model);
    return { response: converted, conversion, provider };
  }

  // Non-streaming: read, convert, re-emit.
  const text = await upstream.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Non-JSON response — surface as error.
    return {
      response:
        clientFormat === "openai"
          ? openAIError(
              502,
              `upstream returned non-JSON body: ${text.slice(0, 200)}`,
              "upstream_error",
            )
          : anthropicError(
              502,
              `upstream returned non-JSON body: ${text.slice(0, 200)}`,
              "upstream_error",
            ),
      conversion: "none",
      provider,
    };
  }
  const convertedBody = convertResponseBody(parsed, conversion);
  return {
    response: new Response(JSON.stringify(convertedBody), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-Pi-Proxy": PI_PROXY_VERSION,
        "X-Pi-Proxy-Provider": provider.name,
        "X-Pi-Proxy-Conversion": conversion,
      },
    }),
    conversion,
    provider,
  };
}

/* ------------------------------------------------------------------ */
/* Demo mode (kept for fallback when no providers / WAF / unreachable) */
/* ------------------------------------------------------------------ */

function normalizeUserMessage(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object") {
          const b = block as { type?: string; text?: unknown };
          if (b.type === "text" && typeof b.text === "string") return b.text;
        }
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return String(raw ?? "");
}

function extractLastUserMessage(body: unknown): string {
  const messages = (body as { messages?: Array<{ role?: string; content?: unknown }> })
    ?.messages;
  if (!Array.isArray(messages)) return "";
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  return normalizeUserMessage(lastUser?.content);
}

function demoResponse(
  model: string,
  body: unknown,
  clientFormat: WireFormat,
): Response {
  const userText = extractLastUserMessage(body);
  const stream = isStreamRequest(body);
  const fullText =
    `π ≈ 3.14159265358979 — ` +
    `(demo response from ${model || "unknown"}). You said: "${userText.slice(0, 160)}". ` +
    `This is a simulated reply because no real upstream provider is ` +
    `configured for this model in ~/.pi/agent/models.json (or demo ` +
    `mode is on). Add a real provider to that file to route requests ` +
    `to a live API.`;

  if (clientFormat === "openai") {
    return demoOpenAI(model || "unknown", fullText, stream);
  }
  return demoAnthropic(model || "unknown", fullText, stream);
}

function demoOpenAI(model: string, text: string, stream: boolean): Response {
  const id = `chatcmpl-demo-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  if (!stream) {
    return new Response(
      JSON.stringify({
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: text },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: Math.ceil(text.length / 8),
          completion_tokens: Math.ceil(text.length / 4),
          total_tokens: Math.ceil(text.length / 8) + Math.ceil(text.length / 4),
        },
        _pi_proxy: { demo: true },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json", "X-Pi-Proxy": "demo" },
      },
    );
  }
  // Streaming demo: chunk by ~3 words.
  const words = text.split(" ");
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += 3) {
    chunks.push(words.slice(i, i + 3).join(" ") + " ");
  }
  const encoder = new TextEncoder();
  const streamBody = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
          })}\n\n`,
        ),
      );
      for (const c of chunks) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: { content: c }, finish_reason: null }],
            })}\n\n`,
          ),
        );
        await new Promise((r) => setTimeout(r, 25));
      }
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\n`,
        ),
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(streamBody, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Pi-Proxy": "demo",
    },
  });
}

function demoAnthropic(model: string, text: string, stream: boolean): Response {
  const messageId = `msg_demo_${Date.now().toString(36)}`;
  if (!stream) {
    return new Response(
      JSON.stringify({
        id: messageId,
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: Math.ceil(text.length / 8),
          output_tokens: Math.ceil(text.length / 4),
        },
        _pi_proxy: { demo: true },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json", "X-Pi-Proxy": "demo" },
      },
    );
  }
  const words = text.split(" ");
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += 3) {
    chunks.push(words.slice(i, i + 3).join(" ") + " ");
  }
  const encoder = new TextEncoder();
  const streamBody = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };
      send("message_start", {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: Math.ceil(text.length / 8), output_tokens: 0 },
        },
      });
      send("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      for (const c of chunks) {
        send("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: c },
        });
        await new Promise((r) => setTimeout(r, 25));
      }
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: Math.ceil(text.length / 4) },
      });
      send("message_stop", { type: "message_stop" });
      controller.close();
    },
  });
  return new Response(streamBody, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Pi-Proxy": "demo",
    },
  });
}

export { maskApiKey };
