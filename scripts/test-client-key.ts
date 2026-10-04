/**
 * Test: client-side API key resolution + upstream header building
 * (offline, no network). Covers the v2.1.1 changes:
 *   - extractClientApiKey: Authorization Bearer / x-api-key / api-key,
 *     priority order, empty/absent handling, raw (non-Bearer) tokens
 *   - buildUpstreamHeaders: the client's key WINS over the server-side
 *     provider key; keyless clients fall back to the provider key
 *   - wire-format auth header shape (x-api-key for anthropic upstreams,
 *     Authorization Bearer for openai upstreams)
 *   - keySource flag ("client" | "server")
 *   - conversion labels are ASCII-only (the `→` form crashed responses:
 *     Node Headers reject non-ASCII header values)
 *
 * Run: bun scripts/test-client-key.ts
 */

import {
  buildUpstreamHeaders,
  extractClientApiKey,
} from "../src/lib/pi-proxy";
import {
  conversionNeeded,
  type Conversion,
} from "../src/lib/format-converter";
import type { PiProvider } from "../src/lib/pi-config";

let passed = 0;
let failed = 0;

function assert(cond: boolean, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ok: ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL: ${label}`);
  }
}

function section(name: string): void {
  console.log(`\n== ${name} ==`);
}

const PROVIDER: PiProvider = {
  name: "AgentRouter-Pi",
  baseUrl: "https://agentrouter.org/v1",
  api: "anthropic-messages",
  apiKey: "sk-server-key-000000",
  apiKeyRaw: "$PI_GATEWAY_API_KEY",
  models: [{ id: "glm-5.3" }],
};

/* ------------------------------------------------------------------ */

section("extractClientApiKey");

{
  const h = new Headers({ Authorization: "Bearer sk-client-abc123" });
  assert(extractClientApiKey(h) === "sk-client-abc123", "Authorization Bearer extracted");
}
{
  const h = new Headers({ authorization: "bearer sk-lower" });
  assert(extractClientApiKey(h) === "sk-lower", "lowercase bearer prefix stripped");
}
{
  const h = new Headers({ "x-api-key": "sk-xkey" });
  assert(extractClientApiKey(h) === "sk-xkey", "x-api-key extracted");
}
{
  const h = new Headers({ "api-key": "sk-alt" });
  assert(extractClientApiKey(h) === "sk-alt", "api-key extracted");
}
{
  const h = new Headers({ "x-api-key": "sk-first", Authorization: "Bearer sk-second" });
  assert(extractClientApiKey(h) === "sk-first", "x-api-key wins over Authorization");
}
{
  const h = new Headers({ Authorization: "Bearer    " });
  assert(extractClientApiKey(h) === "", "Bearer with blank token ignored");
}
{
  const h = new Headers({ Authorization: "Bearer" });
  assert(extractClientApiKey(h) === "", "bare Bearer scheme ignored");
}
{
  const h = new Headers({ Authorization: "Basic dXNlcjpwYXNz" });
  assert(extractClientApiKey(h) === "", "Basic credentials never forwarded as key");
}
{
  const h = new Headers({});
  assert(extractClientApiKey(h) === "", "no auth headers -> empty");
}
{
  const h = new Headers({ Authorization: "raw-token-no-prefix" });
  assert(extractClientApiKey(h) === "raw-token-no-prefix", "raw token (no Bearer) accepted");
}

section("buildUpstreamHeaders: client key wins");

{
  const { headers, keySource } = buildUpstreamHeaders(
    PROVIDER,
    "anthropic",
    new Headers({ Authorization: "Bearer sk-client-xyz" }),
  );
  assert(keySource === "client", "keySource=client when client sent a key");
  assert(headers.get("x-api-key") === "sk-client-xyz", "anthropic upstream: client key in x-api-key");
  assert(headers.get("authorization") === null, "client Authorization not forwarded");
}
{
  const { headers, keySource } = buildUpstreamHeaders(
    PROVIDER,
    "openai",
    new Headers({ Authorization: "Bearer sk-client-xyz" }),
  );
  assert(keySource === "client", "openai upstream: keySource=client");
  assert(headers.get("authorization") === "Bearer sk-client-xyz", "openai upstream: client key as Bearer");
  assert(headers.get("x-api-key") === null, "x-api-key not set for openai upstream");
}

section("buildUpstreamHeaders: server fallback + shape");

{
  const { headers, keySource } = buildUpstreamHeaders(
    PROVIDER,
    "anthropic",
    new Headers({ "User-Agent": "curl/8.0" }),
  );
  assert(keySource === "server", "keySource=server when client sent no key");
  assert(headers.get("x-api-key") === "sk-server-key-000000", "server provider key used as fallback");
  assert(headers.get("anthropic-version") === "2023-06-01", "anthropic-version defaulted");
}
{
  const { headers } = buildUpstreamHeaders(
    PROVIDER,
    "anthropic",
    new Headers({ "anthropic-version": "2023-01-01", "x-api-key": "sk-client" }),
  );
  assert(headers.get("anthropic-version") === "2023-01-01", "client anthropic-version preserved");
  assert(headers.get("x-api-key") === "sk-client", "client key via x-api-key also wins");
}
{
  const { headers } = buildUpstreamHeaders(
    PROVIDER,
    "anthropic",
    new Headers({ Cookie: "SESSION=leak", Authorization: "Bearer sk-client" }),
  );
  assert(headers.get("cookie") === null || headers.get("cookie") === "", "client cookie never leaks upstream");
  assert((headers.get("user-agent") ?? "").startsWith("pi ("), "User-Agent rewritten to pi-style");
}

section("conversion labels are header-safe ASCII");

{
  const c: Conversion = conversionNeeded("openai", "anthropic");
  assert(c === "openai->anthropic", "openai->anthropic label is ASCII");
  const c2: Conversion = conversionNeeded("anthropic", "openai");
  assert(c2 === "anthropic->openai", "anthropic->openai label is ASCII");
  assert(conversionNeeded("openai", "openai") === "none", "same format -> none");
  // The exact property Node's Headers validates: all chars < 0x80.
  for (const label of [c, c2]) {
    assert(
      [...label].every((ch) => ch.charCodeAt(0) < 128),
      `label "${label}" contains only ASCII (header-safe)`,
    );
  }
  // A Response constructed with the label in a header must not throw
  // (the old `→` form threw TypeError here for every converted response).
  const r = new Response("{}", {
    status: 200,
    headers: { "X-Pi-Proxy-Conversion": c },
  });
  assert(r.headers.get("X-Pi-Proxy-Conversion") === c, "header round-trips through Response constructor");
}

/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
