import {
  DEFAULT_API_KEY,
  MODEL_CATALOG,
  PI_PROXY_VERSION,
  UPSTREAM_ANTHROPIC_BASE,
  UPSTREAM_OPENAI_BASE,
  maskApiKey,
} from "@/lib/pi-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/config
 *
 * Returns the public-facing configuration of the Pi proxy. Used by the
 * homepage to render endpoint URLs, model list, and the (masked) API
 * key that's currently burned into the server. The full API key is
 * never returned — clients who want to use it must inherit it server-side.
 */
export async function GET() {
  return Response.json(
    {
      version: PI_PROXY_VERSION,
      api_key_preview: maskApiKey(DEFAULT_API_KEY),
      api_key_configured: Boolean(DEFAULT_API_KEY),
      endpoints: {
        openai: {
          base_url: "/api/v1",
          chat_completions: "/api/v1/chat/completions",
          models: "/api/v1/models",
          upstream: UPSTREAM_OPENAI_BASE,
        },
        anthropic: {
          base_url: "/api",
          messages: "/api/v1/messages",
          upstream: UPSTREAM_ANTHROPIC_BASE,
        },
        health: "/api/health",
        config: "/api/config",
      },
      models: MODEL_CATALOG,
    },
    {
      headers: { "Cache-Control": "no-store" },
    },
  );
}
