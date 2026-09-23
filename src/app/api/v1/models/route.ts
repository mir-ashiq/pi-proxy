import { NextRequest } from "next/server";
import {
  MODEL_CATALOG,
  UPSTREAM_OPENAI_BASE,
  joinUrl,
  openaiUpstreamHeaders,
  resolveApiKey,
  PI_PROXY_VERSION,
} from "@/lib/pi-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/models
 *
 * OpenAI-compatible model listing endpoint. Tries to proxy the upstream
 * AgentRouter `/v1/models` call; if that fails for any reason, falls back
 * to the static MODEL_CATALOG so the client always gets a usable list.
 */
export async function GET(req: NextRequest) {
  const apiKey = resolveApiKey(req);

  let upstreamData: unknown = null;
  let upstreamError: string | null = null;

  try {
    const upstream = await fetch(joinUrl(UPSTREAM_OPENAI_BASE, "/models"), {
      method: "GET",
      headers: openaiUpstreamHeaders(apiKey),
      // Don't hang the whole route on a slow upstream.
      signal: AbortSignal.timeout(8_000),
    });

    if (upstream.ok) {
      const text = await upstream.text();
      try {
        upstreamData = JSON.parse(text);
      } catch {
        upstreamError = `upstream returned non-JSON body (len=${text.length})`;
      }
    } else {
      upstreamError = `upstream ${upstream.status}: ${await upstream.text().catch(() => "")}`;
    }
  } catch (e) {
    upstreamError = e instanceof Error ? e.message : String(e);
  }

  // Static catalog, decorated to look like OpenAI model objects.
  const fallback = MODEL_CATALOG.map((m) => ({
    id: m.id,
    object: "model" as const,
    created: 1_700_000_000,
    owned_by: m.vendor.toLowerCase().replace(/\s+/g, "-"),
    vendor: m.vendor,
    formats: m.formats,
  }));

  if (upstreamData && typeof upstreamData === "object") {
    const upstreamList =
      (upstreamData as { data?: unknown[] }).data ?? [];
    const seen = new Set<string>();
    const merged: unknown[] = [];
    for (const m of upstreamList as Array<Record<string, unknown>>) {
      const id = typeof m?.id === "string" ? m.id : null;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push(m);
    }
    for (const m of fallback) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        merged.push(m);
      }
    }
    return Response.json(
      {
        object: "list",
        data: merged,
        _pi_proxy: {
          version: PI_PROXY_VERSION,
          source: "upstream+catalog",
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

  // Upstream failed — return only the static catalog, with the error
  // surfaced in a non-breaking `_pi_proxy` envelope so the client can
  // decide whether to display a warning.
  return Response.json(
    {
      object: "list",
      data: fallback,
      _pi_proxy: {
        version: PI_PROXY_VERSION,
        source: "catalog-fallback",
        upstream_error: upstreamError,
      },
    },
    {
      status: 200,
      headers: {
        "X-Pi-Proxy": PI_PROXY_VERSION,
        "Cache-Control": "no-store",
      },
    },
  );
}
