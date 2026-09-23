import { NextRequest, NextResponse } from "next/server";
import { PI_PROXY_VERSION } from "@/lib/pi-proxy";
import {
  apiFormatToWireFormat,
  findProviderForModel,
  loadPiConfig,
  maskApiKey,
} from "@/lib/pi-config";
import { conversionNeeded } from "@/lib/format-converter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/debug?model=X&format=openai|anthropic
 *
 * Shows exactly what the proxy will do for a given model + client format:
 *   - Which provider will be used
 *   - What upstream URL will be called
 *   - What headers will be sent (with masked API key)
 *   - Whether format conversion will be applied
 *
 * Useful for diagnosing "unauthorized client" or routing issues.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const model = url.searchParams.get("model") || "";
  const format = (url.searchParams.get("format") || "openai") as
    | "openai"
    | "anthropic";

  const cfg = loadPiConfig();

  if (!model) {
    return NextResponse.json({
      error: "Add ?model=X&format=openai to the URL",
      available_models: cfg.providers.flatMap((p) =>
        p.models.map((m) => m.id),
      ),
    });
  }

  const provider = findProviderForModel(model, format);
  if (!provider) {
    return NextResponse.json(
      {
        error: `Model "${model}" not found in any configured provider`,
        available_models: cfg.providers.flatMap((p) =>
          p.models.map((m) => m.id),
        ),
      },
      { status: 404 },
    );
  }

  const providerFormat = apiFormatToWireFormat(provider.api);
  const conversion = conversionNeeded(format, providerFormat);

  // Build the upstream URL (same logic as the proxy)
  const base = provider.baseUrl.replace(/\/+$/, "");
  let upstreamPath: string;
  if (providerFormat === "openai") {
    upstreamPath = base.endsWith("/v1")
      ? "/chat/completions"
      : "/v1/chat/completions";
  } else {
    upstreamPath = base.endsWith("/v1") ? "/messages" : "/v1/messages";
  }
  const upstreamUrl = `${base}${upstreamPath}`;

  // Show what headers the proxy will send (mask the key)
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "User-Agent": "pi (<platform> <release>; <arch>)  ← Pi-style UA, see note",
  };
  if (providerFormat === "anthropic") {
    headers["x-api-key"] = maskApiKey(provider.apiKey);
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers["Authorization"] = `Bearer ${maskApiKey(provider.apiKey)}`;
  }
  if (provider.cookie) {
    headers["Cookie"] = "(set)";
  }

  return NextResponse.json({
    request: {
      model,
      client_format: format,
    },
    routing: {
      provider_name: provider.name,
      provider_format: providerFormat,
      conversion: conversion,
      upstream_url: upstreamUrl,
      upstream_method: "POST",
    },
    headers_sent_to_upstream: headers,
    note: "The proxy sets User-Agent to 'pi (<platform> <release>; <arch>)' to match what the Pi CLI sends — this is required because AgentRouter does client fingerprinting on User-Agent and rejects non-Pi clients with 'unauthorized client'. Client headers (X-Stainless-*, anthropic-beta, etc.) are also forwarded. Only auth headers are replaced with the provider's key.",
    config_source: cfg.source,
    config_error: cfg.error || null,
    version: PI_PROXY_VERSION,
  });
}
