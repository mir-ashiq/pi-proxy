import {
  DEFAULT_API_KEY,
  PI_PROXY_VERSION,
  maskApiKey,
} from "@/lib/pi-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health
 *
 * Lightweight liveness probe. Does NOT call the upstream.
 */
export async function GET() {
  return Response.json(
    {
      status: "ok",
      version: PI_PROXY_VERSION,
      time: new Date().toISOString(),
      api_key_configured: Boolean(DEFAULT_API_KEY),
      api_key_preview: maskApiKey(DEFAULT_API_KEY),
    },
    {
      headers: { "Cache-Control": "no-store" },
    },
  );
}
