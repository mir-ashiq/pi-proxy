import { NextRequest } from "next/server";
import {
  PI_PROXY_VERSION,
  isStreamRequest,
  openAIError,
  routeAndForward,
} from "@/lib/pi-proxy";
import { getAllModels, loadPiConfig } from "@/lib/pi-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/chat/completions
 *
 * OpenAI Chat Completions compatible endpoint. Routes the request to
 * whichever provider (configured in ~/.pi/agent/models.json) serves
 * the requested model. If the matched provider speaks Anthropic format,
 * the request is converted on the fly and the response is converted back.
 *
 * Any OpenAI SDK pointed at `base_url=http://<host>/api/v1` works.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return openAIError(400, "Invalid JSON body");
  }

  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray((body as { messages?: unknown }).messages)
  ) {
    return openAIError(
      400,
      "Request body must include a `messages` array.",
      "invalid_request_error",
    );
  }

  const result = await routeAndForward(req, body, "openai");
  return result.response;
}

/**
 * GET /api/v1/chat/completions — convenience health probe.
 */
export async function GET() {
  const cfg = loadPiConfig();
  const models = getAllModels();
  return Response.json({
    endpoint: "/api/v1/chat/completions",
    method: "POST",
    description:
      "OpenAI Chat Completions compatible endpoint. Routes to any " +
      "provider configured in ~/.pi/agent/models.json based on the " +
      "requested `model` field. Converts to Anthropic format on the " +
      "fly if needed.",
    version: PI_PROXY_VERSION,
    config_source: cfg.source,
    config_error: cfg.error || null,
    providers_configured: cfg.providers.length,
    models_available: models.length,
    stream_supported: true,
    demo_mode_available: true,
  });
}

// Silence unused import warning for isStreamRequest (used by lib).
export const _isStream = isStreamRequest;
