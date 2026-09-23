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
 * GET /api/config
 *
 * Returns the proxy's view of the loaded Pi config: which providers are
 * configured (with masked API keys), which models are available, and
 * the routing table. API keys are never exposed in full — only masked.
 */
export async function GET(_req: NextRequest) {
  const cfg = loadPiConfig();
  const models = getAllModels();

  return Response.json(
    {
      version: PI_PROXY_VERSION,
      config_source: cfg.source,
      config_loaded_at: new Date(cfg.loadedAt).toISOString(),
      config_error: cfg.error || null,
      providers: cfg.providers.map((p) => ({
        name: p.name,
        baseUrl: p.baseUrl,
        api: p.api,
        format: apiFormatToWireFormat(p.api),
        apiKey_preview: maskApiKey(p.apiKey),
        apiKey_configured: Boolean(p.apiKey),
        apiKey_source: p.apiKeyRaw.startsWith("$")
          ? `env:${p.apiKeyRaw.slice(1)}`
          : "literal",
        models: p.models.map((m) => ({ id: m.id, name: m.name || m.id })),
        has_cookie: Boolean(p.cookie),
      })),
      models: models.map((m) => ({
        id: m.id,
        name: m.name,
        providers: m.providers,
        formats: m.formats,
      })),
      endpoints: {
        openai: {
          base_url: "/api/v1",
          chat_completions: "/api/v1/chat/completions",
          models: "/api/v1/models",
        },
        anthropic: {
          base_url: "/api",
          messages: "/api/v1/messages",
        },
        health: "/api/health",
        config: "/api/config",
      },
      demo_mode: process.env.PI_DEMO_MODE === "1" || process.env.PI_DEMO_MODE === "true",
    },
    {
      headers: { "Cache-Control": "no-store" },
    },
  );
}
