# π Pi Proxy Server

A **config-driven AI gateway** that reads your [Pi CLI](https://pi.dev) config (`~/.pi/agent/models.json`) and exposes every configured provider as a unified OpenAI + Anthropic compatible API.

## Architecture

```
┌─────────────────────┐     ┌─────────────────────┐     ┌─────────────────────┐
│  1. Pi config       │     │  2. Pi Proxy        │     │  3. Your providers  │
│  ~/.pi/agent/       │ ──▶ │  /api/v1/*          │ ──▶ │  OpenAI · Anthropic │
│  models.json        │     │  routes by model    │     │  AgentRouter · …    │
│                     │     │  converts formats   │     │                     │
│  (your providers,  │     │  (openai↔anthropic) │     │  (real upstreams,   │
│   keys, formats)    │     │                     │     │   your keys)        │
└─────────────────────┘     └─────────────────────┘     └─────────────────────┘
```

**You configure providers once in Pi's `models.json`** — any baseUrl, any apiKey, any wire format. The proxy reads that config and routes each incoming request to the matching provider based on the requested model. If the client's format differs from the provider's, the proxy converts on the fly (OpenAI ↔ Anthropic, including streaming SSE).

## Endpoints

| Method | Path | Format | Description |
|--------|------|--------|-------------|
| `POST` | `/api/v1/chat/completions` | OpenAI | Chat completions (streaming + non-streaming) |
| `POST` | `/api/v1/messages` | Anthropic | Messages (streaming + non-streaming) |
| `GET`  | `/api/v1/models` | OpenAI | All models from all configured providers |
| `GET`  | `/api/health` | — | Liveness probe |
| `GET`  | `/api/config` | — | Loaded providers + routing table (masked keys) |

## Quick start

### 1. Configure your providers in Pi

Edit `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "My-OpenAI": {
      "baseUrl": "https://api.openai.com/v1",
      "api": "openai-completions",
      "apiKey": "$OPENAI_API_KEY",
      "models": [
        { "id": "gpt-4", "name": "gpt-4" },
        { "id": "gpt-4o", "name": "gpt-4o" }
      ]
    },
    "My-Anthropic": {
      "baseUrl": "https://api.anthropic.com",
      "api": "anthropic-messages",
      "apiKey": "$ANTHROPIC_API_KEY",
      "models": [
        { "id": "claude-opus-4-1", "name": "claude-opus-4-1" },
        { "id": "claude-sonnet-4", "name": "claude-sonnet-4" }
      ]
    }
  }
}
```

The `apiKey` field accepts either a literal string or `$ENV_VAR_NAME` (Pi's convention — the proxy resolves it from the environment).

### 2. Set your API keys in the environment

```bash
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."
```

### 3. Install & run the proxy

```bash
bun install
bun run dev
```

The proxy is now live at `http://localhost:3000`. It reads your Pi config on startup (and re-reads every 5 seconds, so config changes are picked up live).

### 4. Use with any OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/api/v1",
    api_key="any-string",  # proxy uses keys from your Pi config
)

# This routes to "My-OpenAI" (no conversion needed)
resp = client.chat.completions.create(
    model="gpt-4",
    messages=[{"role": "user", "content": "Say hi"}],
)

# This routes to "My-Anthropic" (proxy converts openai→anthropic on the fly)
resp = client.chat.completions.create(
    model="claude-opus-4-1",
    messages=[{"role": "user", "content": "Say hi"}],
)
```

### 5. Use with any Anthropic SDK

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="http://localhost:3000/api",
    api_key="any-string",
)

# Routes to "My-Anthropic" (no conversion)
msg = client.messages.create(
    model="claude-opus-4-1",
    max_tokens=512,
    messages=[{"role": "user", "content": "Say hi"}],
)

# Routes to "My-OpenAI" (proxy converts anthropic→openai)
msg = client.messages.create(
    model="gpt-4",
    max_tokens=512,
    messages=[{"role": "user", "content": "Say hi"}],
)
```

### 6. Use with Pi CLI

Pi and the proxy share the same config file, so once your providers are in `~/.pi/agent/models.json`, both work:

```bash
pi --print --no-tools --provider My-OpenAI --model gpt-4 "Hello!"
```

## How routing works

When a request arrives with `model: "X"`:

1. The proxy looks up `X` across all providers in your Pi config.
2. If multiple providers serve `X`, it prefers one whose wire format matches the client's request (to avoid conversion).
3. If no same-format provider exists, it picks the first match and converts the request/response on the fly.
4. The request is forwarded to that provider's `baseUrl` with that provider's resolved `apiKey`.

Format conversions supported:
- **Request body**: OpenAI system messages → Anthropic `system` field (and back),
  `reasoning_content`/`reasoning`/`reasoning_text` ↔ `thinking` content blocks,
  `tools`/`tool_calls`/`role:"tool"` ↔ `tools`/`tool_use`/`tool_result`,
  `image_url` parts (data: and http URLs) ↔ `image` blocks,
  `reasoning_effort` → Anthropic `thinking` parameter
- **Non-streaming response**: `choices[0].message.content` ↔ `content[].text`,
  `reasoning_content` ↔ `content[].thinking`, `tool_calls` ↔ `tool_use`,
  finish_reason ↔ stop_reason, usage
- **Streaming SSE**: `data: {choices:[{delta:{content}}]}` ↔ `event: content_block_delta`,
  `delta.reasoning_content` ↔ `thinking_delta`, `delta.tool_calls` ↔ `tool_use` +
  `input_json_delta` (with proper terminal events and usage on both sides)

## Thinking-mode replay padding

Strict thinking-mode channels (z.ai GLM-family upstreams behind relays) reject
a request whose assistant history lacks reasoning — error text:
`The content[].thinking in the thinking mode must be passed back to the API`.
Turns without reasoning appear when the conversation failed over across models
or when an older proxy/consumer dropped the reasoning. The proxy pads those
turns automatically, in the shape the upstream wants:

- **OpenAI-format upstreams**: assistant messages missing the conversation's
  reasoning field (`reasoning_content` / `reasoning` / `reasoning_text`)
  gain it as an empty string — the shape a thinking-mode upstream itself
  returns for a turn that produced no reasoning.
- **Anthropic-format upstreams**: assistant messages that don't open with a
  `thinking` content block get one prepended (placeholder text, configurable).

The gate is self-limiting: padding only applies when the conversation already
speaks a reasoning dialect, the model is known to produce reasoning (learned
from observed responses, in-memory), or the config forces it. Configure per
provider in `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "AgentRouter-Anthropic": {
      "baseUrl": "https://agentrouter.org/v1",
      "api": "anthropic-messages",
      "apiKey": "$PI_GATEWAY_API_KEY",
      "thinkingPadding": "always",
      "models": [
        { "id": "glm-5.3", "thinking": true },
        { "id": "claude-opus-5" }
      ]
    }
  }
}
```

- `thinkingPadding`: `"auto"` (default) | `"always"` | `"never"` per provider.
- `thinking`: `true` | `false` per model entry (overrides the provider mode).

**Why an Anthropic-format provider matters for strict channels**: a relay's
OpenAI ingress generally cannot carry thinking as a content block
(`unknown variant `thinking``), while its Anthropic `/v1/messages` endpoint
natively accepts and replays `content[].thinking` blocks. Pointing the
provider at the Anthropic endpoint lets the proxy convert and pad end-to-end.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PI_CONFIG_PATH` | `~/.pi/agent/models.json` | Path to Pi's models.json |
| `PI_DEMO_MODE` | `0` | When `1`, returns simulated SSE responses without hitting upstreams |
| `PI_UPSTREAM_COOKIE_<ProviderName>` | (none) | Optional cookie forwarded to a specific provider (for WAF bypass) |
| `PI_THINKING_PADDING` | (unset) | Global override for thinking-replay padding: `auto` / `always` / `never` |
| `PI_THINKING_PLACEHOLDER` | `.` | Placeholder text for padded Anthropic thinking blocks |
| `PI_STREAM_TIMEOUT_MS` | `600000` | Hard cap for streaming upstream fetches (zombie reaping) |

API keys are **not** set via env vars on the proxy directly — they come from the `apiKey` field in each provider's config (which itself can reference `$ENV_VAR`).

## Client-side API keys (v2.1.1)

The proxy prefers **the key the client presents** over the server-side
provider key. A request carrying `Authorization: Bearer <k>`, `x-api-key: <k>`,
or `api-key: <k>` forwards that exact key upstream (remapped to the header
shape the upstream's wire format expects). Keyless clients fall back to the
provider's `apiKey` from models.json.

This means key rotation happens **where the client is configured** — e.g.
LEGION's `settings.yaml` or a CLI env var — with no edits on the proxy VPS.
Every provider-routed response carries `X-Pi-Proxy-Key-Source: client|server`
so you can verify which key reached the upstream. Auth schemes that are not
API keys (`Basic`, `Digest`, a bare `Bearer`, …) are never forwarded.

## Demo mode

For verifying the proxy plumbing without reachable upstreams:

- Globally: `PI_DEMO_MODE=1` in `.env`
- Per-request: `x-pi-demo: 1` header

Returns well-formed simulated OpenAI/Anthropic SSE streams.

## Observability

Every proxied response carries `X-Pi-Proxy` headers:

- `X-Pi-Proxy` — proxy version
- `X-Pi-Proxy-Provider` — provider that served the request
- `X-Pi-Proxy-Conversion` — `none` / `openai->anthropic` / `anthropic->openai`
- `X-Pi-Proxy-Think-Pad` — `dialect` / `forced` / `off` plus how many turns
  were padded (e.g. `dialect;padded=3`)
- `X-Pi-Proxy-Key-Source` — `client` / `server`: which API key reached the
  upstream (the client's own header, or the provider's server-side key)

`GET /api/config` also reports the per-provider padding mode and the learned
list of thinking-producing models; `GET /api/debug?model=X&format=openai`
shows exactly how a request would be routed, converted, and padded.

## Tech stack

- [Next.js 16](https://nextjs.org/) (App Router, Node.js runtime)
- [TypeScript 5](https://www.typescriptlang.org/)
- [Tailwind CSS 4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/)

## License

MIT
