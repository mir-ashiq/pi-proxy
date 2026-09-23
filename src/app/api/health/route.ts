import { PI_PROXY_VERSION } from "@/lib/pi-proxy";
import { loadPiConfig } from "@/lib/pi-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health
 *
 * Liveness probe. Reports whether the Pi config loaded successfully
 * and how many providers/models are available.
 */
export async function GET() {
  const cfg = loadPiConfig();
  const modelsCount = cfg.providers.reduce(
    (sum, p) => sum + p.models.length,
    0,
  );
  return Response.json(
    {
      status: cfg.error ? "degraded" : "ok",
      version: PI_PROXY_VERSION,
      time: new Date().toISOString(),
      config_source: cfg.source,
      config_error: cfg.error || null,
      providers_configured: cfg.providers.length,
      models_configured: modelsCount,
      demo_mode: process.env.PI_DEMO_MODE === "1" || process.env.PI_DEMO_MODE === "true",
    },
    {
      headers: { "Cache-Control": "no-store" },
    },
  );
}
