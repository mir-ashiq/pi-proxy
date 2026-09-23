import { NextRequest } from "next/server";
import {
  UPSTREAM_ANTHROPIC_BASE,
  anthropicUpstreamHeaders,
  demoAnthropicResponse,
  detectWafChallenge,
  errorResponse,
  isStreamRequest,
  joinUrl,
  proxyStreamResponse,
  resolveApiKey,
  shouldUseDemo,
} from "@/lib/pi-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/messages
 *
 * Anthropic Messages API compatible endpoint. Forwards the request body
 * verbatim to AgentRouter's `/v1/messages` upstream and streams the SSE
 * response back byte-for-byte when `stream: true`.
 *
 * Any Anthropic SDK pointed at `ANTHROPIC_BASE_URL=https://<this-host>/api`
 * will work without changes (the SDK will append `/v1/messages`).
 *
 * Demo mode: if `PI_DEMO_MODE=1` or the request includes
 * `x-pi-demo: 1`, the proxy returns simulated SSE responses so the
 * plumbing can be verified without a reachable upstream.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  if (
    typeof body !== "object" ||
    body === null ||
    !(body as { messages?: unknown }).messages
  ) {
    return errorResponse(
      400,
      "Request body must include a `messages` array.",
      "invalid_request_error",
    );
  }

  const stream = isStreamRequest(body);
  const model =
    typeof (body as { model?: unknown }).model === "string"
      ? ((body as { model: string }).model)
      : "unknown";

  // Extract last user message for demo content.
  const messages = (body as { messages?: Array<{ role?: string; content?: unknown }> }).messages || [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  // Pass the raw content (string OR Anthropic content-blocks array) —
  // the demo helper normalizes it.
  const userText = (lastUser?.content ?? "") as unknown;

  // Demo mode short-circuits the upstream call entirely.
  if (shouldUseDemo(req)) {
    return demoAnthropicResponse(model, userText, stream);
  }

  const apiKey = resolveApiKey(req);

  // Forward Anthropic-version if the client set one, otherwise the
  // helper will inject a sane default.
  const clientAnthropicVersion = req.headers.get("anthropic-version");
  const headers = clientAnthropicVersion
    ? anthropicUpstreamHeaders(apiKey, {
        "anthropic-version": clientAnthropicVersion,
      })
    : anthropicUpstreamHeaders(apiKey);

  // Forward Anthropic beta flags if present.
  const betaHeader = req.headers.get("anthropic-beta");
  if (betaHeader) headers.set("anthropic-beta", betaHeader);

  const upstream = await fetch(
    joinUrl(UPSTREAM_ANTHROPIC_BASE, "/v1/messages"),
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: stream ? undefined : AbortSignal.timeout(120_000),
    },
  ).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`upstream fetch failed: ${msg}`);
  });

  // Detect Aliyun WAF challenge.
  if (upstream.headers.get("content-type")?.includes("text/html")) {
    const sample = await upstream.text().catch(() => "");
    const waf = detectWafChallenge(upstream, sample);
    if (waf) {
      return errorResponse(502, waf, "upstream_waf_challenge", "WAF_CHALLENGE");
    }
    return errorResponse(
      502,
      `upstream returned HTML instead of JSON (status ${upstream.status}). First 200 chars: ${sample.slice(0, 200)}`,
      "upstream_error",
    );
  }

  if (!upstream.ok && !stream) {
    const text = await upstream.text().catch(() => "");
    return errorResponse(
      upstream.status,
      text || `upstream returned ${upstream.status}`,
      "upstream_error",
    );
  }

  if (!upstream.ok && stream) {
    const text = await upstream.text().catch(() => "");
    const errorPayload = JSON.stringify({
      type: "error",
      error: {
        type: "upstream_error",
        message: text || `upstream returned ${upstream.status}`,
      },
    });
    const sse = `event: error\ndata: ${errorPayload}\n\n`;
    return new Response(sse, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  return proxyStreamResponse(upstream);
}

/**
 * GET /api/v1/messages — convenience health probe.
 */
export async function GET() {
  return Response.json({
    endpoint: "/api/v1/messages",
    method: "POST",
    upstream: joinUrl(UPSTREAM_ANTHROPIC_BASE, "/v1/messages"),
    description:
      "Anthropic Messages API compatible proxy. POST an Anthropic messages request body.",
  });
}
