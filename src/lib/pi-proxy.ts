/**
 * Pi Proxy Server — core configuration & helpers.
 *
 * This module exposes the upstream endpoints and the API key that the
 * Pi-compatible proxy uses to forward OpenAI / Anthropic format requests
 * to AgentRouter (https://agentrouter.org/docs/pi.html).
 *
 * The Pi agent (https://pi.dev) supports two provider types:
 *   - "openai-completions"  → POST {base_url}/chat/completions
 *   - "anthropic-messages"  → POST {base_url}/v1/messages
 *
 * AgentRouter accepts both formats. The Pi proxy therefore exposes:
 *   - POST /api/v1/chat/completions  (OpenAI Chat Completions)
 *   - POST /api/v1/messages          (Anthropic Messages)
 *   - GET  /api/v1/models            (OpenAI-style model list)
 *
 * The proxy is transparent: it forwards the body verbatim, swaps in the
 * upstream API key when the client does not provide one, and streams the
 * upstream SSE response back to the caller byte-for-byte.
 */

export const PI_PROXY_VERSION = "1.0.0";

/** Default API key read from the environment. */
export const DEFAULT_API_KEY = process.env.PI_GATEWAY_API_KEY || "";

/** OpenAI-format upstream base URL (already includes /v1). */
export const UPSTREAM_OPENAI_BASE =
  process.env.PI_UPSTREAM_OPENAI || "https://agentrouter.org/v1";

/** Anthropic-format upstream base URL (no /v1 suffix). */
export const UPSTREAM_ANTHROPIC_BASE =
  process.env.PI_UPSTREAM_ANTHROPIC || "https://agentrouter.org";

/**
 * Optional cookie string forwarded to the upstream on every request.
 *
 * AgentRouter sits behind an Aliyun WAF that issues a slider captcha
 * challenge to non-browser clients. To use the proxy against the real
 * upstream, the operator must:
 *
 *   1. Open https://agentrouter.org in a browser.
 *   2. Solve the slider captcha once.
 *   3. Copy the `acw_tc` cookie (and any session cookies) from the
 *      browser's dev tools -> Application -> Cookies.
 *   4. Set PI_UPSTREAM_COOKIE="acw_tc=...; other=..." in .env.
 *
 * When unset, the proxy will attempt the upstream call anyway, but
 * requests will likely fail with a 403 / WAF challenge HTML body.
 */
export const UPSTREAM_COOKIE = process.env.PI_UPSTREAM_COOKIE || "";

/**
 * Demo mode toggle. When `PI_DEMO_MODE=1` is set in the environment,
 * OR the request includes the `x-pi-demo: 1` header, the proxy
 * returns simulated streaming responses instead of hitting the upstream.
 *
 * This is useful for verifying the proxy plumbing (SSE framing, format
 * compatibility) when the real upstream is unreachable (e.g. behind a
 * WAF that requires a browser-solved captcha).
 */
export const DEMO_MODE = process.env.PI_DEMO_MODE === "1" ||
  process.env.PI_DEMO_MODE === "true";

/** Returns true if the request should be served in demo mode. */
export function shouldUseDemo(req: Request): boolean {
  if (DEMO_MODE) return true;
  const h = req.headers.get("x-pi-demo");
  return h === "1" || h === "true";
}

/**
 * Normalize a user message that may arrive as a plain string OR as
 * an Anthropic-style content-blocks array (e.g. `[{"type":"text","text":"hi"}]`).
 * Returns a clean string suitable for echoing back in demo responses.
 *
 * Pi sends messages in content-blocks form even when calling OpenAI-format
 * providers, so without this normalization the demo response would contain
 * raw JSON instead of the actual user prompt.
 */
export function normalizeUserMessage(raw: unknown): string {
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
  if (raw && typeof raw === "object") return JSON.stringify(raw);
  return String(raw ?? "");
}

/**
 * Generate a fake but well-formed OpenAI Chat Completions response.
 * If `stream` is true, returns a ReadableStream of SSE events.
 * If `stream` is false, returns a JSON object.
 */
export function demoOpenAIResponse(
  model: string,
  userMessage: unknown,
  stream: boolean,
): Response {
  const cleanUser = normalizeUserMessage(userMessage);
  const fullText =
    `π ≈ 3.14159265358979 — ` +
    `(demo response from ${model}). You said: "${cleanUser.slice(0, 160)}". ` +
    `This is a simulated reply because the upstream AgentRouter API is ` +
    `behind an Aliyun WAF slider captcha that server-side fetches cannot ` +
    `solve. Set PI_UPSTREAM_COOKIE with your browser's acw_tc cookie to ` +
    `route requests to the real upstream.`;

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
            message: { role: "assistant", content: fullText },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: Math.ceil(cleanUser.length / 4),
          completion_tokens: Math.ceil(fullText.length / 4),
          total_tokens:
            Math.ceil(cleanUser.length / 4) +
            Math.ceil(fullText.length / 4),
        },
        _pi_proxy: { demo: true },
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Pi-Proxy": "demo",
        },
      },
    );
  }

  // Streaming: split into ~3-word chunks and emit one SSE event per chunk.
  const words = fullText.split(" ");
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += 3) {
    chunks.push(words.slice(i, i + 3).join(" ") + " ");
  }

  const encoder = new TextEncoder();
  const streamBody = new ReadableStream<Uint8Array>({
    async start(controller) {
      // First chunk: role
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta: { role: "assistant" },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        ),
      );
      // Subsequent chunks: content
      for (const c of chunks) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: { content: c },
                  finish_reason: null,
                },
              ],
            })}\n\n`,
          ),
        );
        // Tiny delay so the streaming is visible in the UI.
        await new Promise((r) => setTimeout(r, 25));
      }
      // Final chunk: finish_reason
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "stop",
              },
            ],
          })}\n\n`,
        ),
      );
      controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
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

/**
 * Generate a fake but well-formed Anthropic Messages response.
 * Respects the `stream` flag and emits proper Anthropic SSE events.
 */
export function demoAnthropicResponse(
  model: string,
  userMessage: unknown,
  stream: boolean,
): Response {
  const cleanUser = normalizeUserMessage(userMessage);
  const fullText =
    `π ≈ 3.14159265358979 — ` +
    `(demo response from ${model}). You said: "${cleanUser.slice(0, 160)}". ` +
    `This is a simulated reply because the upstream AgentRouter API is ` +
    `behind an Aliyun WAF slider captcha that server-side fetches cannot ` +
    `solve. Set PI_UPSTREAM_COOKIE with your browser's acw_tc cookie to ` +
    `route requests to the real upstream.`;

  const messageId = `msg_demo_${Date.now().toString(36)}`;

  if (!stream) {
    return new Response(
      JSON.stringify({
        id: messageId,
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: fullText }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: Math.ceil(cleanUser.length / 4),
          output_tokens: Math.ceil(fullText.length / 4),
        },
        _pi_proxy: { demo: true },
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Pi-Proxy": "demo",
        },
      },
    );
  }

  // Streaming: emit message_start, content_block_start, content_block_delta*,
  // content_block_stop, message_delta, message_stop.
  const words = fullText.split(" ");
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
          usage: { input_tokens: Math.ceil(cleanUser.length / 4), output_tokens: 0 },
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
      send("content_block_stop", {
        type: "content_block_stop",
        index: 0,
      });
      send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: Math.ceil(fullText.length / 4) },
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

/**
 * Catalog of models currently advertised by AgentRouter, per
 * https://agentrouter.org/docs/pi.html. The upstream model list is
 * dynamic, so this static catalog is used only as a fallback when the
 * upstream /v1/models call fails.
 */
export interface ModelInfo {
  id: string;
  name: string;
  vendor: string;
  /** Which wire formats this model accepts on AgentRouter. */
  formats: Array<"openai" | "anthropic">;
}

export const MODEL_CATALOG: ModelInfo[] = [
  {
    id: "gpt-5.6-sol",
    name: "gpt-5.6-sol",
    vendor: "OpenAI",
    formats: ["openai"],
  },
  {
    id: "gpt-6-astra",
    name: "gpt-6-astra",
    vendor: "OpenAI",
    formats: ["openai"],
  },
  {
    id: "claude-opus-5",
    name: "claude-opus-5",
    vendor: "Anthropic",
    formats: ["anthropic"],
  },
  {
    id: "claude-opus-4-8",
    name: "claude-opus-4-8",
    vendor: "Anthropic",
    formats: ["anthropic"],
  },
  {
    id: "glm-5.3",
    name: "glm-5.3",
    vendor: "Zhipu AI",
    formats: ["openai", "anthropic"],
  },
  {
    id: "deepseek-v4-flash",
    name: "deepseek-v4-flash",
    vendor: "Deepseek",
    formats: ["openai", "anthropic"],
  },
];

/**
 * Mask an API key for safe display: keep the first 7 and last 4 chars,
 * replace everything in between with dots. Returns "(none)" if empty.
 */
export function maskApiKey(key: string | null | undefined): string {
  if (!key) return "(none)";
  if (key.length <= 11) return "****";
  return `${key.slice(0, 7)}${"•".repeat(12)}${key.slice(-4)}`;
}

/**
 * Extract an API key from an incoming request.
 *
 * Lookup order:
 *   1. `Authorization: Bearer <key>` (OpenAI convention)
 *   2. `x-api-key: <key>`            (Anthropic convention)
 *   3. The server's default `DEFAULT_API_KEY`
 *
 * This lets clients either rely on the test key burned into the proxy,
 * or override it with their own key per-request.
 */
export function resolveApiKey(req: Request): string {
  const auth = req.headers.get("authorization");
  if (auth && /^Bearer\s+/i.test(auth)) {
    const bearer = auth.replace(/^Bearer\s+/i, "").trim();
    if (bearer) return bearer;
  }
  const xApiKey = req.headers.get("x-api-key");
  if (xApiKey) return xApiKey.trim();
  return DEFAULT_API_KEY;
}

/** Headers required for an OpenAI-format upstream call. */
export function openaiUpstreamHeaders(apiKey: string, extra?: HeadersInit) {
  const h = new Headers({
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "User-Agent": `pi-proxy/${PI_PROXY_VERSION}`,
    ...(extra ? Object.fromEntries(new Headers(extra).entries()) : {}),
  });
  if (UPSTREAM_COOKIE) h.set("Cookie", UPSTREAM_COOKIE);
  return h;
}

/** Headers required for an Anthropic-format upstream call. */
export function anthropicUpstreamHeaders(
  apiKey: string,
  extra?: HeadersInit,
) {
  const h = new Headers({
    "x-api-key": apiKey,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    // Anthropic requires an explicit API version header.
    "anthropic-version": "2023-06-01",
    "User-Agent": `pi-proxy/${PI_PROXY_VERSION}`,
    ...(extra ? Object.fromEntries(new Headers(extra).entries()) : {}),
  });
  if (UPSTREAM_COOKIE) h.set("Cookie", UPSTREAM_COOKIE);
  return h;
}

/**
 * Detect an Aliyun WAF challenge response. The WAF returns a 200 OK
 * with `Content-Type: text/html` containing `aliyun_waf_aa` meta tags
 * and an obfuscated JS payload that renders a slider captcha. Real API
 * responses are always JSON or SSE.
 *
 * Returns a human-readable hint when a WAF challenge is detected, or
 * `null` if the response looks like a legitimate API response.
 */
export function detectWafChallenge(
  upstream: Response,
  bodyText: string,
): string | null {
  const ct = upstream.headers.get("content-type") || "";
  if (!ct.includes("text/html")) return null;
  if (!bodyText) return null;
  if (
    bodyText.includes("aliyun_waf_aa") ||
    bodyText.includes("initAliyunCaptcha") ||
    bodyText.includes("CF_APP_WAF")
  ) {
    return (
      "AgentRouter upstream returned an Aliyun WAF slider-captcha challenge. " +
      "Server-to-server fetches cannot pass this challenge automatically. " +
      "Set PI_UPSTREAM_COOKIE in .env with the acw_tc cookie from your " +
      "browser session at https://agentrouter.org to forward requests " +
      "through an already-solved captcha session."
    );
  }
  return null;
}

/**
 * Convert an upstream fetch Response into a streaming Response that the
 * Next.js runtime can return from a route handler. The body is forwarded
 * verbatim so SSE framing survives intact.
 */
export function proxyStreamResponse(
  upstream: Response,
  fallbackContentType = "text/event-stream",
): Response {
  const contentType =
    upstream.headers.get("content-type") || fallbackContentType;
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Pi-Proxy": PI_PROXY_VERSION,
  };
  // Forward rate-limit headers when present (helps clients back off).
  for (const h of [
    "x-ratelimit-limit-requests",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-reset-requests",
    "x-request-id",
  ]) {
    const v = upstream.headers.get(h);
    if (v) headers[h] = v;
  }
  if (!upstream.body) {
    return new Response("upstream returned empty body", {
      status: 502,
      headers,
    });
  }
  return new Response(upstream.body as unknown as BodyInit, {
    status: upstream.status,
    headers,
  });
}

/**
 * Forward a JSON error to the caller in OpenAI-style error envelope.
 * Used when the upstream call fails before any body is returned.
 */
export function errorResponse(
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

/**
 * Decide whether a request body is asking for streaming. Works for both
 * OpenAI (`stream: true`) and Anthropic (`stream: true`) formats.
 */
export function isStreamRequest(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const v = (body as { stream?: unknown }).stream;
  return v === true || v === "true";
}

/** Build an absolute upstream URL from a base and a relative path. */
export function joinUrl(base: string, path: string): string {
  const left = base.replace(/\/+$/, "");
  const right = path.replace(/^\/+/, "");
  return `${left}/${right}`;
}
