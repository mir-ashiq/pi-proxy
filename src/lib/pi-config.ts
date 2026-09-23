/**
 * Pi config reader.
 *
 * The Pi CLI (https://pi.dev) stores its third-party provider config in
 * `~/.pi/agent/models.json`. This module reads that file, resolves
 * `$ENV_VAR` references in apiKey fields, and exposes lookup helpers
 * so the proxy can route incoming requests to the right upstream.
 *
 * The config file format (per https://agentrouter.org/docs/pi.html):
 *
 *   {
 *     "providers": {
 *       "<provider-name>": {
 *         "baseUrl": "https://api.openai.com/v1",
 *         "api": "openai-completions" | "anthropic-messages",
 *         "apiKey": "$OPENAI_API_KEY",  // literal OR $ENV_VAR reference
 *         "models": [
 *           { "id": "gpt-4", "name": "gpt-4" }
 *         ]
 *       }
 *     }
 *   }
 *
 * A model may appear under multiple providers (e.g. glm-5.3 supports both
 * OpenAI and Anthropic formats). When routing, we prefer a provider whose
 * `api` field matches the incoming request format; otherwise we use the
 * first provider that lists the model.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ApiFormat = "openai-completions" | "anthropic-messages";
export type WireFormat = "openai" | "anthropic";

export interface PiModelEntry {
  id: string;
  name?: string;
}

export interface PiProvider {
  /** Provider name (key in the `providers` object). */
  name: string;
  /** Upstream base URL. */
  baseUrl: string;
  /** Wire format the upstream speaks. */
  api: ApiFormat;
  /** Resolved API key (after $ENV_VAR expansion). */
  apiKey: string;
  /** Raw apiKey string from the config (for masked display). */
  apiKeyRaw: string;
  /** Models advertised by this provider. */
  models: PiModelEntry[];
  /** Optional cookie forwarded to the upstream. */
  cookie?: string;
}

export interface PiConfig {
  providers: PiProvider[];
  /** Path the config was loaded from. */
  source: string;
  /** When the config was loaded (epoch ms). */
  loadedAt: number;
  /** Error if the config failed to load. */
  error?: string;
}

/** Path to the Pi models.json file. */
export const PI_CONFIG_PATH =
  process.env.PI_CONFIG_PATH ||
  join(homedir(), ".pi", "agent", "models.json");

/** Per-provider cookie overrides via env (rare; mainly for WAF bypass). */
const PI_PROVIDER_COOKIE_PREFIX = "PI_UPSTREAM_COOKIE_";

/** Cache the parsed config for 5 seconds to avoid re-reading on every request. */
let cachedConfig: PiConfig | null = null;
const CACHE_TTL_MS = 5_000;

/** Resolve a Pi-style apiKey reference (`$ENV_VAR` or literal) to its value. */
function resolveApiKey(raw: string): string {
  if (!raw) return "";
  if (raw.startsWith("$")) {
    const envName = raw.slice(1);
    return process.env[envName] || "";
  }
  return raw;
}

/** Mask an API key for safe display: keep first 7 and last 4 chars. */
export function maskApiKey(key: string | null | undefined): string {
  if (!key) return "(none)";
  if (key.length <= 11) return "****";
  return `${key.slice(0, 7)}${"•".repeat(12)}${key.slice(-4)}`;
}

/** Convert Pi's `api` field value to our WireFormat union. */
export function apiFormatToWireFormat(api: ApiFormat): WireFormat {
  return api === "anthropic-messages" ? "anthropic" : "openai";
}

/**
 * Load and parse the Pi models.json file. Cached for `CACHE_TTL_MS`.
 * Never throws — returns a PiConfig with `.error` set on failure.
 */
export function loadPiConfig(): PiConfig {
  const now = Date.now();
  if (cachedConfig && now - cachedConfig.loadedAt < CACHE_TTL_MS) {
    return cachedConfig;
  }

  try {
    const raw = readFileSync(PI_CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as {
      providers?: Record<string, unknown>;
    };

    const providers: PiProvider[] = [];
    if (parsed.providers && typeof parsed.providers === "object") {
      for (const [name, p] of Object.entries(parsed.providers)) {
        if (!p || typeof p !== "object") continue;
        const provider = p as {
          baseUrl?: string;
          api?: string;
          apiKey?: string;
          models?: PiModelEntry[];
          cookie?: string;
        };
        if (!provider.baseUrl || !provider.api) continue;

        const apiKeyRaw = provider.apiKey || "";
        const apiKey = resolveApiKey(apiKeyRaw);
        const cookie =
          provider.cookie ||
          process.env[`${PI_PROVIDER_COOKIE_PREFIX}${name}`] ||
          "";

        providers.push({
          name,
          baseUrl: provider.baseUrl,
          api: provider.api as ApiFormat,
          apiKey,
          apiKeyRaw,
          models: Array.isArray(provider.models) ? provider.models : [],
          cookie,
        });
      }
    }

    cachedConfig = {
      providers,
      source: PI_CONFIG_PATH,
      loadedAt: now,
    };
    return cachedConfig;
  } catch (e) {
    cachedConfig = {
      providers: [],
      source: PI_CONFIG_PATH,
      loadedAt: now,
      error: e instanceof Error ? e.message : String(e),
    };
    return cachedConfig;
  }
}

/**
 * Find the provider that serves a given model.
 *
 * Lookup order:
 *   1. Any provider whose `models` list contains an entry with `id === model`.
 *   2. Among matches, prefer one whose wire format matches `preferredFormat`.
 *   3. If no preferred-format match, return the first match.
 *
 * Returns `null` if no provider lists the model.
 */
export function findProviderForModel(
  model: string,
  preferredFormat?: WireFormat,
): PiProvider | null {
  const cfg = loadPiConfig();
  const matches = cfg.providers.filter((p) =>
    p.models.some((m) => m.id === model),
  );
  if (matches.length === 0) return null;
  if (preferredFormat) {
    const fmt = matches.find(
      (p) => apiFormatToWireFormat(p.api) === preferredFormat,
    );
    if (fmt) return fmt;
  }
  return matches[0];
}

/** Return a flat list of all models across all providers, deduped by id. */
export function getAllModels(): Array<{
  id: string;
  name: string;
  providers: Array<{ name: string; format: WireFormat }>;
}> {
  const cfg = loadPiConfig();
  const map = new Map<
    string,
    {
      id: string;
      name: string;
      providers: Array<{ name: string; format: WireFormat }>;
    }
  >();
  for (const p of cfg.providers) {
    for (const m of p.models) {
      const id = m.id;
      if (!map.has(id)) {
        map.set(id, {
          id,
          name: m.name || m.id,
          providers: [],
        });
      }
      map.get(id)!.providers.push({
        name: p.name,
        format: apiFormatToWireFormat(p.api),
      });
    }
  }
  return Array.from(map.values());
}
