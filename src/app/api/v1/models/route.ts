import { NextRequest } from "next/server";
import { PI_PROXY_VERSION } from "@/lib/pi-proxy";
import {
  apiFormatToWireFormat,
  getAllModels,
  loadPiConfig,
  maskApiKey,
} from "@/lib/pi-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/models
 *
 * Returns an OpenAI-style model list built from ALL providers configured
 * in ~/.pi/agent/models.json. Each model entry includes a `providers`
 * array showing which upstream providers serve it and in which wire format,
 * so clients can see what's available.
 *
 * Accepts an optional `?format=openai|anthropic` query param to filter
 * models to those served by at least one provider in that format.
 */
export async function GET(req: NextRequest) {
  const cfg = loadPiConfig();
  const allModels = getAllModels();

  const formatFilter = req.nextUrl.searchParams.get("format");
  const models =
    formatFilter === "openai" || formatFilter === "anthropic"
      ? allModels.filter((m) =>
          m.providers.some((p) => p.format === formatFilter),
        )
      : allModels;

  const data = models.map((m) => ({
    id: m.id,
    object: "model" as const,
    created: 1_700_000_000,
    owned_by: m.providers[0]?.name || "unknown",
    name: m.name,
    providers: m.providers.map((p) => ({
      name: p.name,
      format: p.format,
    })),
    // Convenience: which wire formats this model supports across all providers.
    formats: m.providers.map((p) => p.format),
  }));

  return Response.json(
    {
      object: "list",
      data,
      _pi_proxy: {
        version: PI_PROXY_VERSION,
        config_source: cfg.source,
        config_error: cfg.error || null,
        providers_total: cfg.providers.length,
        providers: cfg.providers.map((p) => ({
          name: p.name,
          baseUrl: p.baseUrl,
          api: p.api,
          format: apiFormatToWireFormat(p.api),
          apiKey_preview: maskApiKey(p.apiKey),
          apiKey_configured: Boolean(p.apiKey),
          models_count: p.models.length,
          has_cookie: Boolean(p.cookie),
        })),
      },
    },
    {
      headers: {
        "X-Pi-Proxy": PI_PROXY_VERSION,
        "Cache-Control": "no-store",
      },
    },
  );
}
