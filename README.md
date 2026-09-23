# π Pi Proxy Server

A Pi-compatible proxy server that bridges **OpenAI Chat Completions** and **Anthropic Messages** wire formats to the [AgentRouter](https://agentrouter.org/docs/pi.html) upstream.

One server, both wire formats, full streaming support. Drop-in compatible with the OpenAI SDK, the Anthropic SDK, and the [Pi CLI coding agent](https://pi.dev).

## Endpoints

| Method | Path | Format | Description |
|--------|------|--------|-------------|
| `POST` | `/api/v1/chat/completions` | OpenAI | Chat completions (streaming + non-streaming) |
| `POST` | `/api/v1/messages` | Anthropic | Messages (streaming + non-streaming) |
| `GET`  | `/api/v1/models` | OpenAI | Model listing |
| `GET`  | `/api/health` | — | Liveness probe |
| `GET`  | `/api/config` | — | Public config introspection |

## Quick start

### 1. Configure environment

```bash
cp .env.example .env
# Edit .env and set PI_GATEWAY_API_KEY
```

### 2. Install & run

```bash
bun install
bun run dev
```

The proxy is now live at `http://localhost:3000`.

### 3. Use with OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/api/v1",
    api_key="sk-test",  # any non-empty string — the proxy injects the real key
)

resp = client.chat.completions.create(
    model="deepseek-v4-flash",
    messages=[{"role": "user", "content": "Say hi in 5 words."}],
)
print(resp.choices[0].message.content)
```

### 4. Use with Anthropic SDK

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="http://localhost:3000/api",
    api_key="sk-test",  # any non-empty string — the proxy injects the real key
)

msg = client.messages.create(
    model="claude-opus-4-8",
    max_tokens=512,
    messages=[{"role": "user", "content": "Say hi in 5 words."}],
)
print(msg.content[0].text)
```

### 5. Use with Pi CLI

Drop this into `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "AgentRouter-Pi-OpenAI": {
      "baseUrl": "http://localhost:3000/api/v1",
      "api": "openai-completions",
      "apiKey": "$PI_GATEWAY_API_KEY",
      "models": [
        { "id": "deepseek-v4-flash", "name": "deepseek-v4-flash" },
        { "id": "glm-5.3", "name": "glm-5.3" },
        { "id": "gpt-5.6-sol", "name": "gpt-5.6-sol" },
        { "id": "gpt-6-astra", "name": "gpt-6-astra" }
      ]
    },
    "AgentRouter-Pi-Anthropic": {
      "baseUrl": "http://localhost:3000/api",
      "api": "anthropic-messages",
      "apiKey": "$PI_GATEWAY_API_KEY",
      "models": [
        { "id": "claude-opus-5", "name": "claude-opus-5" },
        { "id": "claude-opus-4-8", "name": "claude-opus-4-8" },
        { "id": "glm-5.3", "name": "glm-5.3" },
        { "id": "deepseek-v4-flash", "name": "deepseek-v4-flash" }
      ]
    }
  }
}
```

Then:

```bash
export PI_GATEWAY_API_KEY="your-agentrouter-key"
pi --print --no-tools --provider AgentRouter-Pi-OpenAI --model deepseek-v4-flash "Hello!"
```

## How it works

1. **Client sends request** — An OpenAI or Anthropic SDK POSTs to the proxy.
2. **Proxy forwards upstream** — Swaps in the AgentRouter API key (or honors a client-supplied one), sets the right headers, forwards to `agentrouter.org`.
3. **Stream flows back** — The SSE response is piped back byte-for-byte, so token streaming, tool calls, and stop reasons all survive intact.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PI_GATEWAY_API_KEY` | (none) | AgentRouter API key, forwarded to the upstream |
| `PI_UPSTREAM_OPENAI` | `https://agentrouter.org/v1` | OpenAI-format upstream base URL |
| `PI_UPSTREAM_ANTHROPIC` | `https://agentrouter.org` | Anthropic-format upstream base URL |
| `PI_UPSTREAM_COOKIE` | (none) | Optional cookie string forwarded to upstream (for WAF bypass) |
| `PI_DEMO_MODE` | `0` | When `1`, returns simulated SSE responses without hitting upstream |

## Notes on the AgentRouter WAF

AgentRouter sits behind an Aliyun WAF that may issue a slider captcha to non-browser clients depending on source IP/region. The proxy detects this and returns a clean `502 WAF_CHALLENGE` error with fix instructions.

If you hit this:

1. Open `https://agentrouter.org` in a browser.
2. Solve the slider captcha once.
3. Copy the `acw_tc` cookie (and any session cookies) from dev tools → Application → Cookies.
4. Set `PI_UPSTREAM_COOKIE="acw_tc=...; other=..."` in `.env`.

## Demo mode

For verifying the proxy plumbing without a reachable upstream, enable **Demo mode**:

- Globally: `PI_DEMO_MODE=1` in `.env`
- Per-request: `x-pi-demo: 1` header

Demo mode returns well-formed simulated OpenAI/Anthropic SSE streams.

## Tech stack

- [Next.js 16](https://nextjs.org/) (App Router, Node.js runtime)
- [TypeScript 5](https://www.typescriptlang.org/)
- [Tailwind CSS 4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/)

## License

MIT
