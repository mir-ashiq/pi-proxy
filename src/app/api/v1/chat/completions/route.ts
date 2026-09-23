import { NextRequest } from "next/server";
import {
  DEFAULT_API_KEY,
  UPSTREAM_OPENAI_BASE,
  demoOpenAIResponse,
  detectWafChallenge,
  errorResponse,
  isStreamRequest,
  joinUrl,
  openaiUpstreamHeaders,
  proxyStreamResponse,
  resolveApiKey,
  shouldUseDemo,
} from "@/lib/pi-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/chat/completions
 *
 * OpenAI Chat Completions compatible endpoint. Forwards the request
 * body verbatim to AgentRouter's `/v1/chat/completions` upstream and
 * streams the SSE response back byte-for-byte when `stream: true`.
 *
 * The proxy is wire-compatible: any OpenAI SDK pointed at
 * `OPENAI_BASE_URL=https://<this-host>/api/v1` will work without changes.
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
    return demoOpenAIResponse(model, userText, stream);
  }

  const apiKey = resolveApiKey(req);

  const upstream = await fetch(
    joinUrl(UPSTREAM_OPENAI_BASE, "/chat/completions"),
    {
      method: "POST",
      headers: openaiUpstreamHeaders(apiKey),
      body: JSON.stringify(body),
      signal: stream ? undefined : AbortSignal.timeout(120_000),
    },
  ).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`upstream fetch failed: ${msg}`);
  });

  // Detect Aliyun WAF challenge. The upstream returns 200 OK with an
  // HTML body containing a slider captcha — not a real API response.
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
    const errorBody = JSON.stringify({
      error: {
        message: text || `upstream returned ${upstream.status}`,
        type: "upstream_error",
        code: upstream.status,
      },
    });
    const sse = `data: ${errorBody}\n\ndata: [DONE]\n\n`;
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
 * GET /api/v1/chat/completions — convenience health probe.
 */
export async function GET() {
  return Response.json({
    endpoint: "/api/v1/chat/completions",
    method: "POST",
    upstream: joinUrl(UPSTREAM_OPENAI_BASE, "/chat/completions"),
    description:
      "OpenAI Chat Completions compatible proxy. POST a chat-completions request body.",
    api_key_configured: Boolean(DEFAULT_API_KEY),
  });
}
