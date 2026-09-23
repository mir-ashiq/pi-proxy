'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { useToast } from "@/hooks/use-toast"
import { Copy, Check, Terminal, Send, Loader2, CircleCheck, TriangleAlert, Zap, Github, BookOpen } from "lucide-react"

/* ------------------------------------------------------------------ */
/* Static metadata                                                     */
/* ------------------------------------------------------------------ */

const PROXY_INFO = {
  version: "1.0.0",
  // The actual API key is read server-side from PI_GATEWAY_API_KEY env var.
  // The client only ever sees the masked preview from /api/config.
  defaultApiKey: "",
  apiKeyPreview: "(server-side only)",
  upstreamOpenAI: "https://agentrouter.org/v1",
  upstreamAnthropic: "https://agentrouter.org",
}

const ENDPOINTS = [
  {
    label: "OpenAI Chat Completions",
    path: "/api/v1/chat/completions",
    method: "POST",
    format: "OpenAI",
    upstream: PROXY_INFO.upstreamOpenAI + "/chat/completions",
  },
  {
    label: "OpenAI Models",
    path: "/api/v1/models",
    method: "GET",
    format: "OpenAI",
    upstream: PROXY_INFO.upstreamOpenAI + "/models",
  },
  {
    label: "Anthropic Messages",
    path: "/api/v1/messages",
    method: "POST",
    format: "Anthropic",
    upstream: PROXY_INFO.upstreamAnthropic + "/v1/messages",
  },
  {
    label: "Health Probe",
    path: "/api/health",
    method: "GET",
    format: "Pi Proxy",
    upstream: "—",
  },
]

/* ------------------------------------------------------------------ */
/* Small primitives                                                    */
/* ------------------------------------------------------------------ */

function useCopy() {
  const { toast } = useToast()
  const [copied, setCopied] = useState<string | null>(null)
  const copy = useCallback((text: string, id: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(id)
      setTimeout(() => setCopied(null), 1500)
      toast({ title: "Copied to clipboard", duration: 1500 })
    })
  }, [toast])
  return { copied, copy }
}

function CodeBlock({ code, lang = "bash", id }: { code: string; lang?: string; id: string }) {
  const { copied, copy } = useCopy()
  return (
    <div className="relative group">
      <pre className="bg-zinc-950 text-zinc-100 rounded-lg p-4 pr-12 text-xs sm:text-sm overflow-x-auto font-mono leading-relaxed border border-zinc-800">
        <code>{code}</code>
      </pre>
      <div className="absolute top-1 right-1 flex items-center gap-1">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500 px-1.5 py-0.5">{lang}</span>
        <button
          onClick={() => copy(code, id)}
          className="p-1.5 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 transition-colors"
          aria-label="Copy code"
        >
          {copied === id ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      </div>
    </div>
  )
}

function EndpointRow({ ep }: { ep: (typeof ENDPOINTS)[number] }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 border-b border-zinc-100 last:border-0">
      <div className="flex items-center gap-2 min-w-0">
        <Badge
          variant="outline"
          className={
            "font-mono text-[10px] px-1.5 py-0 " +
            (ep.method === "POST"
              ? "bg-amber-50 text-amber-700 border-amber-200"
              : "bg-emerald-50 text-emerald-700 border-emerald-200")
          }
        >
          {ep.method}
        </Badge>
        <code className="text-sm font-mono text-zinc-800 truncate">{ep.path}</code>
      </div>
      <Badge variant="secondary" className="text-[10px] whitespace-nowrap">
        {ep.format}
      </Badge>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Live tester state                                                   */
/* ------------------------------------------------------------------ */

type ApiFormat = "openai" | "anthropic"
type Status = "idle" | "sending" | "streaming" | "done" | "error"

interface ModelInfo {
  id: string
  name: string
  vendor: string
  formats: Array<"openai" | "anthropic">
}

interface ConfigResponse {
  version: string
  api_key_preview: string
  api_key_configured: boolean
  endpoints: Record<string, unknown>
  models: ModelInfo[]
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function Home() {
  const [format, setFormat] = useState<ApiFormat>("openai")
  const [models, setModels] = useState<ModelInfo[]>([])
  const [config, setConfig] = useState<ConfigResponse | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)

  // Tester form state
  const [systemPrompt, setSystemPrompt] = useState("You are a concise, helpful assistant.")
  const [userMessage, setUserMessage] = useState("What is π to 20 decimal places?")
  const [stream, setStream] = useState(true)
  const [temperature, setTemperature] = useState(0.7)
  const [maxTokens, setMaxTokens] = useState(512)
  const [selectedModel, setSelectedModel] = useState<string>("deepseek-v4-flash")
  const [demoMode, setDemoMode] = useState(false)

  // Response state
  const [status, setStatus] = useState<Status>("idle")
  const [rendered, setRendered] = useState<string>("")
  const [rawSse, setRawSse] = useState<string>("")
  const [latencyMs, setLatencyMs] = useState<number | null>(null)
  const [errorText, setErrorText] = useState<string>("")

  const abortRef = useRef<AbortController | null>(null)
  const rawRef = useRef<HTMLPreElement | null>(null)

  /* Fetch configuration + model list on mount */
  useEffect(() => {
    let cancelled = false
    fetch("/api/config")
      .then((r) => r.json())
      .then((data: ConfigResponse) => {
        if (cancelled) return
        setConfig(data)
        setModels(data.models || [])
        if (data.models.length > 0) {
          // Pick the first dual-format model so the format toggle is
          // symmetrical.
          const dual = data.models.find((m) => m.formats.includes("openai"))
          if (dual) setSelectedModel(dual.id)
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setConfigError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const availableModels = useMemo(
    () => models.filter((m) => m.formats.includes(format)),
    [models, format],
  )

  // Derive the effective model at render time. If the user-selected
  // model is not compatible with the current format (e.g. they
  // switched tabs), fall back to the first compatible one — no
  // effect needed, no extra render.
  const effectiveModel = useMemo(() => {
    if (availableModels.length === 0) return selectedModel
    return availableModels.find((m) => m.id === selectedModel)
      ? selectedModel
      : availableModels[0].id
  }, [availableModels, selectedModel])

  /* ---- Send ---------------------------------------------------------- */
  const send = useCallback(async () => {
    if (status === "sending" || status === "streaming") return
    setStatus("sending")
    setRendered("")
    setRawSse("")
    setErrorText("")
    setLatencyMs(null)

    const controller = new AbortController()
    abortRef.current = controller
    const started = performance.now()

    const path =
      format === "openai" ? "/api/v1/chat/completions" : "/api/v1/messages"

    const body =
      format === "openai"
        ? {
            model: effectiveModel,
            messages: [
              ...(systemPrompt
                ? [{ role: "system", content: systemPrompt }]
                : []),
              { role: "user", content: userMessage },
            ],
            stream,
            temperature,
            max_tokens: maxTokens,
          }
        : {
            model: effectiveModel,
            max_tokens: maxTokens,
            ...(systemPrompt ? { system: systemPrompt } : {}),
            messages: [{ role: "user", content: userMessage }],
            stream,
            temperature,
          }

    let res: Response
    try {
      res = await fetch(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(format === "anthropic"
            ? { "anthropic-version": "2023-06-01" }
            : {}),
          ...(demoMode ? { "x-pi-demo": "1" } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (e: unknown) {
      setStatus("error")
      setErrorText(e instanceof Error ? e.message : String(e))
      return
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      setStatus("error")
      setErrorText(`HTTP ${res.status} — ${text || res.statusText}`)
      return
    }

    if (!stream) {
      // Non-streaming: read full body, parse once.
      const text = await res.text()
      setRawSse(text)
      try {
        const json = JSON.parse(text)
        const content =
          format === "openai"
            ? json?.choices?.[0]?.message?.content
            : json?.content?.map((c: { text?: string }) => c.text).join("")
        setRendered(content || "(empty response)")
        setStatus("done")
        setLatencyMs(Math.round(performance.now() - started))
        return
      } catch {
        setRendered("(invalid JSON response)")
        setStatus("error")
        return
      }
    }

    // Streaming: consume SSE incrementally.
    setStatus("streaming")
    if (!res.body) {
      setStatus("error")
      setErrorText("No response body.")
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    let acc = ""

    const pushRaw = (chunk: string) => {
      setRawSse((prev) => prev + chunk)
    }

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        pushRaw(chunk)
        buf += chunk

        // Split into SSE events separated by blank lines, but for
        // incremental display we process line-by-line.
        const lines = buf.split("\n")
        buf = lines.pop() || ""

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          if (!trimmed.startsWith("data:")) continue
          const payload = trimmed.slice(5).trim()
          if (payload === "[DONE]") continue
          try {
            const json = JSON.parse(payload)
            if (format === "openai") {
              const delta = json?.choices?.[0]?.delta?.content
              if (delta) {
                acc += delta
                setRendered(acc)
              }
            } else {
              // Anthropic streaming events
              if (json?.type === "content_block_delta" && json?.delta?.text) {
                acc += json.delta.text
                setRendered(acc)
              } else if (json?.type === "message_start" && json?.message?.usage) {
                // ignore — informational
              }
            }
          } catch {
            // ignore non-JSON lines
          }
        }
      }
      setStatus("done")
      setLatencyMs(Math.round(performance.now() - started))
    } catch (e: unknown) {
      if (controller.signal.aborted) {
        setStatus("done")
        return
      }
      setStatus("error")
      setErrorText(e instanceof Error ? e.message : String(e))
    }
  }, [demoMode, format, maxTokens, effectiveModel, stream, systemPrompt, temperature, userMessage, status])

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    setStatus("done")
  }, [])

  // Auto-scroll raw SSE panel as it grows
  useEffect(() => {
    if (rawRef.current) {
      rawRef.current.scrollTop = rawRef.current.scrollHeight
    }
  }, [rawSse])

  /* ---- Curl command for the current config -------------------------- */
  const curlCommand = useMemo(() => {
    const path =
      format === "openai" ? "/api/v1/chat/completions" : "/api/v1/messages"
    const body =
      format === "openai"
        ? {
            model: effectiveModel,
            messages: [
              ...(systemPrompt
                ? [{ role: "system", content: systemPrompt }]
                : []),
              { role: "user", content: userMessage },
            ],
            stream,
            temperature,
            max_tokens: maxTokens,
          }
        : {
            model: effectiveModel,
            max_tokens: maxTokens,
            ...(systemPrompt ? { system: systemPrompt } : {}),
            messages: [{ role: "user", content: userMessage }],
            stream,
            temperature,
          }
    const headerLine =
      format === "anthropic"
        ? `-H "anthropic-version: 2023-06-01"`
        : ""
    const demoLine = demoMode ? `-H "x-pi-demo: 1"` : ""
    const headers = [
      `-H "Content-Type: application/json"`,
      headerLine,
      demoLine,
      // No Authorization header — the proxy uses the burned-in test key.
    ].filter(Boolean)
    return [
      `curl -X POST '${path}' \\`,
      ...headers.map((h) => `  ${h} \\`),
      `  -d '${JSON.stringify(body)}'`,
    ].join("\n")
  }, [demoMode, format, maxTokens, effectiveModel, stream, systemPrompt, temperature, userMessage])

  const piConfig = useMemo(() => {
    return JSON.stringify(
      {
        providers: {
          "AgentRouter-Pi-OpenAI": {
            baseUrl: "/api/v1",
            api: "openai-completions",
            apiKey: "$PI_GATEWAY_API_KEY",
            models: models
              .filter((m) => m.formats.includes("openai"))
              .map((m) => ({ id: m.id, name: m.name })),
          },
          "AgentRouter-Pi-Anthropic": {
            baseUrl: "/api",
            api: "anthropic-messages",
            apiKey: "$PI_GATEWAY_API_KEY",
            models: models
              .filter((m) => m.formats.includes("anthropic"))
              .map((m) => ({ id: m.id, name: m.name })),
          },
        },
      },
      null,
      2,
    )
  }, [models])

  return (
    <div className="min-h-screen flex flex-col bg-zinc-50 text-zinc-900">
      {/* Sticky header */}
      <header className="sticky top-0 z-30 backdrop-blur-md bg-white/85 border-b border-zinc-200">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="size-8 rounded-md bg-amber-600 text-white font-serif font-bold flex items-center justify-center text-lg shadow-sm">
              π
            </div>
            <div className="leading-tight">
              <div className="font-semibold text-sm">Pi Proxy Server</div>
              <div className="text-[11px] text-zinc-500 font-mono">
                v{PROXY_INFO.version}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="hidden sm:inline-flex text-[11px] gap-1">
              <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Live
            </Badge>
            <a
              href="https://agentrouter.org/docs/pi.html"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-zinc-600 hover:text-zinc-900 px-2.5 py-1.5 rounded-md hover:bg-zinc-100 transition-colors"
            >
              <BookOpen className="size-3.5" />
              <span className="hidden sm:inline">Pi Docs</span>
            </a>
            <a
              href="https://pi.dev"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-zinc-600 hover:text-zinc-900 px-2.5 py-1.5 rounded-md hover:bg-zinc-100 transition-colors"
            >
              <Github className="size-3.5" />
              <span className="hidden sm:inline">pi.dev</span>
            </a>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-8 sm:py-12 space-y-10">
        {/* Hero */}
        <section className="text-center space-y-4 pt-2">
          <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 font-mono">
            OpenAI · Anthropic · Pi-compatible
          </Badge>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-zinc-900">
            Pi Proxy Server
          </h1>
          <p className="text-base sm:text-lg text-zinc-600 max-w-2xl mx-auto">
            A drop-in OpenAI &amp; Anthropic-compatible gateway that forwards requests to
            AgentRouter. One server, both wire formats, full streaming support.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
            <Button asChild>
              <a href="#tester">
                <Zap className="size-4" />
                Try it live
              </a>
            </Button>
            <Button asChild variant="outline">
              <a href="#endpoints">View endpoints</a>
            </Button>
          </div>
        </section>

        {/* Status banner */}
        {configError && (
          <Alert variant="destructive">
            <TriangleAlert className="size-4" />
            <AlertTitle>Could not load proxy config</AlertTitle>
            <AlertDescription className="font-mono text-xs">
              {configError}
            </AlertDescription>
          </Alert>
        )}
        {!configError && config && (
          <Alert className="border-emerald-200 bg-emerald-50 text-emerald-800">
            <CircleCheck className="size-4" />
            <AlertTitle>Proxy ready</AlertTitle>
            <AlertDescription>
              Using test key <span className="font-mono">{config.api_key_preview}</span> · {models.length} models loaded ·
              upstream{" "}
              <a className="underline" href={PROXY_INFO.upstreamOpenAI} target="_blank" rel="noreferrer">
                agentrouter.org
              </a>
            </AlertDescription>
          </Alert>
        )}
        <Alert className="border-amber-200 bg-amber-50 text-amber-900">
          <TriangleAlert className="size-4" />
          <AlertTitle>Upstream note — Demo mode available as fallback</AlertTitle>
          <AlertDescription className="space-y-1.5 text-xs">
            <p>
              AgentRouter sits behind an Aliyun WAF slider captcha that may challenge
              non-browser requests depending on source IP/region. If the tester below
              returns a <code className="font-mono bg-amber-100 px-1 py-0.5 rounded">502 WAF_CHALLENGE</code>
              {" "}error, turn on <strong>Demo mode</strong> to verify the proxy plumbing
              with simulated SSE streams.
            </p>
            <p>
              To route real traffic through, set{" "}
              <code className="font-mono bg-amber-100 px-1 py-0.5 rounded">PI_UPSTREAM_COOKIE</code>
              {" "}in <code className="font-mono bg-amber-100 px-1 py-0.5 rounded">.env</code>
              {" "}with the <code className="font-mono bg-amber-100 px-1 py-0.5 rounded">acw_tc</code>
              {" "}cookie from your browser session at{" "}
              <a className="underline" href="https://agentrouter.org" target="_blank" rel="noreferrer">
                agentrouter.org
              </a>.
            </p>
          </AlertDescription>
        </Alert>

        {/* Endpoints */}
        <section id="endpoints" className="space-y-4 scroll-mt-20">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold">Endpoints</h2>
              <p className="text-sm text-zinc-600">
                All paths are relative to this host. Point any OpenAI or Anthropic SDK at <code className="font-mono text-xs bg-zinc-100 px-1 py-0.5 rounded">/api/v1</code>.
              </p>
            </div>
          </div>
          <Card>
            <CardContent className="p-0 sm:p-2">
              {ENDPOINTS.map((ep) => (
                <EndpointRow key={ep.path} ep={ep} />
              ))}
            </CardContent>
          </Card>
        </section>

        {/* Quick start */}
        <section className="space-y-4">
          <div>
            <h2 className="text-xl font-semibold">Quick start</h2>
            <p className="text-sm text-zinc-600">
              The proxy ships with a burned-in test API key, so requests work out of the box. Bring your own key via <code className="font-mono text-xs bg-zinc-100 px-1 py-0.5 rounded">Authorization: Bearer …</code> or <code className="font-mono text-xs bg-zinc-100 px-1 py-0.5 rounded">x-api-key</code> to override.
            </p>
          </div>
          <Tabs defaultValue="openai">
            <TabsList className="w-full justify-start">
              <TabsTrigger value="openai">OpenAI SDK</TabsTrigger>
              <TabsTrigger value="anthropic">Anthropic SDK</TabsTrigger>
              <TabsTrigger value="curl">curl</TabsTrigger>
              <TabsTrigger value="pi">Pi config</TabsTrigger>
            </TabsList>

            <TabsContent value="openai" className="mt-4 space-y-3">
              <p className="text-sm text-zinc-600">
                Point any OpenAI-compatible client at <code className="font-mono text-xs bg-zinc-100 px-1 py-0.5 rounded">baseURL=&quot;/api/v1&quot;</code> and the proxy will forward to AgentRouter.
              </p>
              <CodeBlock
                id="openai-sdk"
                lang="python"
                code={`from openai import OpenAI

client = OpenAI(
    base_url="/api/v1",
    api_key="sk-test",  # any non-empty string — the proxy injects the real key
)

resp = client.chat.completions.create(
    model="deepseek-v4-flash",
    messages=[{"role": "user", "content": "Say hi in 5 words."}],
)
print(resp.choices[0].message.content)`}
              />
            </TabsContent>

            <TabsContent value="anthropic" className="mt-4 space-y-3">
              <p className="text-sm text-zinc-600">
                Point the Anthropic SDK at <code className="font-mono text-xs bg-zinc-100 px-1 py-0.5 rounded">base_url=&quot;/api&quot;</code> (the SDK appends <code className="font-mono text-xs bg-zinc-100 px-1 py-0.5 rounded">/v1/messages</code>).
              </p>
              <CodeBlock
                id="anthropic-sdk"
                lang="python"
                code={`from anthropic import Anthropic

client = Anthropic(
    base_url="/api",
    api_key="sk-test",  # any non-empty string — the proxy injects the real key
)

msg = client.messages.create(
    model="claude-opus-4-8",
    max_tokens=512,
    messages=[{"role": "user", "content": "Say hi in 5 words."}],
)
print(msg.content[0].text)`}
              />
            </TabsContent>

            <TabsContent value="curl" className="mt-4 space-y-3">
              <p className="text-sm text-zinc-600">
                Run this in your terminal against the live proxy:
              </p>
              <CodeBlock id="curl-cmd" lang="bash" code={curlCommand} />
            </TabsContent>

            <TabsContent value="pi" className="mt-4 space-y-3">
              <p className="text-sm text-zinc-600">
                Drop this into <code className="font-mono text-xs bg-zinc-100 px-1 py-0.5 rounded">~/.pi/agent/models.json</code> and Pi (the CLI agent) will use this proxy as a third-party provider. Both OpenAI and Anthropic models are wired up.
              </p>
              <CodeBlock id="pi-config" lang="json" code={piConfig} />
            </TabsContent>
          </Tabs>
        </section>

        {/* Interactive tester */}
        <section id="tester" className="space-y-4 scroll-mt-20">
          <div>
            <h2 className="text-xl font-semibold">Live tester</h2>
            <p className="text-sm text-zinc-600">
              Send a real request through the proxy and watch the SSE stream arrive token-by-token.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Form */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Request</CardTitle>
                  <Tabs value={format} onValueChange={(v) => setFormat(v as ApiFormat)}>
                    <TabsList className="h-7">
                      <TabsTrigger value="openai" className="text-xs px-2.5 py-0">OpenAI</TabsTrigger>
                      <TabsTrigger value="anthropic" className="text-xs px-2.5 py-0">Anthropic</TabsTrigger>
                    </TabsList>
                  </Tabs>
                </div>
                <CardDescription className="text-xs">
                  POST {format === "openai" ? "/api/v1/chat/completions" : "/api/v1/messages"}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="model" className="text-xs">Model</Label>
                  <Select value={effectiveModel} onValueChange={setSelectedModel}>
                    <SelectTrigger id="model" className="h-9">
                      <SelectValue placeholder="Pick a model" />
                    </SelectTrigger>
                    <SelectContent>
                      {availableModels.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          <span className="font-mono">{m.name}</span>
                          <span className="ml-2 text-xs text-zinc-500">{m.vendor}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="system" className="text-xs">System prompt</Label>
                  <Textarea
                    id="system"
                    rows={2}
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    className="text-sm resize-y"
                    placeholder="You are a helpful assistant."
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="user" className="text-xs">User message</Label>
                  <Textarea
                    id="user"
                    rows={4}
                    value={userMessage}
                    onChange={(e) => setUserMessage(e.target.value)}
                    className="text-sm resize-y"
                    placeholder="Ask anything…"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Temperature: {temperature.toFixed(2)}</Label>
                    <Slider
                      value={[temperature]}
                      min={0}
                      max={2}
                      step={0.05}
                      onValueChange={(v) => setTemperature(v[0] ?? 0.7)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="max" className="text-xs">Max tokens</Label>
                    <Input
                      id="max"
                      type="number"
                      min={1}
                      max={8192}
                      value={maxTokens}
                      onChange={(e) => setMaxTokens(Number(e.target.value) || 0)}
                      className="h-9"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between pt-1">
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <Switch checked={stream} onCheckedChange={setStream} id="stream" />
                      <Label htmlFor="stream" className="text-xs">Stream (SSE)</Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch checked={demoMode} onCheckedChange={setDemoMode} id="demo" />
                      <Label htmlFor="demo" className="text-xs">Demo mode</Label>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {(status === "sending" || status === "streaming") && (
                      <Button variant="outline" size="sm" onClick={cancel}>
                        Cancel
                      </Button>
                    )}
                    <Button
                      size="sm"
                      onClick={send}
                      disabled={status === "sending" || status === "streaming" || !userMessage.trim()}
                    >
                      {status === "sending" || status === "streaming" ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Send className="size-3.5" />
                      )}
                      Send
                    </Button>
                  </div>
                </div>

                {errorText && (
                  <Alert variant="destructive" className="py-2">
                    <TriangleAlert className="size-3.5" />
                    <AlertDescription className="text-xs font-mono">{errorText}</AlertDescription>
                  </Alert>
                )}
              </CardContent>
            </Card>

            {/* Response */}
            <Card className="flex flex-col">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Response</CardTitle>
                  <div className="flex items-center gap-2">
                    {latencyMs !== null && (
                      <Badge variant="secondary" className="text-[10px] font-mono">
                        {latencyMs} ms
                      </Badge>
                    )}
                    <StatusBadge status={status} />
                  </div>
                </div>
                <CardDescription className="text-xs">
                  Rendered output · streaming updates in real time
                </CardDescription>
              </CardHeader>
              <CardContent className="flex-1 flex flex-col gap-3">
                <div className="rounded-md border border-zinc-200 bg-white p-3 min-h-[160px]">
                  <pre className="whitespace-pre-wrap text-sm font-sans leading-relaxed text-zinc-800">
                    {rendered || <span className="text-zinc-400 italic">No response yet — hit Send.</span>}
                  </pre>
                </div>
                <Separator />
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <Terminal className="size-3.5 text-zinc-500" />
                    <span className="text-xs font-medium text-zinc-600">Raw SSE stream</span>
                  </div>
                  <pre
                    ref={rawRef}
                    className="bg-zinc-950 text-zinc-300 rounded-md p-3 text-[11px] font-mono overflow-auto max-h-48 min-h-[120px] leading-relaxed"
                  >
                    {rawSse || <span className="text-zinc-600 italic">SSE chunks will appear here…</span>}
                  </pre>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>

        {/* How it works */}
        <section className="space-y-4">
          <div>
            <h2 className="text-xl font-semibold">How it works</h2>
            <p className="text-sm text-zinc-600">Three layers, no surprises.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[
              {
                n: "1",
                title: "Client sends request",
                body: "An OpenAI or Anthropic SDK POSTs to /api/v1/chat/completions or /api/v1/messages. The request body is untouched.",
              },
              {
                n: "2",
                title: "Proxy forwards upstream",
                body: "The proxy swaps in the AgentRouter API key (or honors a client-supplied one), sets the right headers, and forwards to agentrouter.org.",
              },
              {
                n: "3",
                title: "Stream flows back",
                body: "The SSE response is piped back byte-for-byte, so token streaming, tool calls, and stop reasons all survive intact.",
              },
            ].map((s) => (
              <Card key={s.n}>
                <CardContent className="pt-5">
                  <div className="flex items-start gap-3">
                    <div className="size-7 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center font-bold text-sm shrink-0">
                      {s.n}
                    </div>
                    <div>
                      <h3 className="font-medium text-sm">{s.title}</h3>
                      <p className="text-xs text-zinc-600 mt-1 leading-relaxed">{s.body}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      </main>

      <footer className="mt-auto border-t border-zinc-200 bg-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs text-zinc-500">
          <div className="flex items-center gap-2">
            <div className="size-5 rounded bg-amber-600 text-white font-serif font-bold flex items-center justify-center text-xs">
              π
            </div>
            <span>
              Pi Proxy Server · v{PROXY_INFO.version} · Built for{" "}
              <a className="underline hover:text-zinc-900" href="https://agentrouter.org/docs/pi.html" target="_blank" rel="noreferrer">
                AgentRouter Pi
              </a>
            </span>
          </div>
          <div className="flex items-center gap-3">
            <a className="hover:text-zinc-900" href="/api/health" target="_blank" rel="noreferrer">Health</a>
            <a className="hover:text-zinc-900" href="/api/config" target="_blank" rel="noreferrer">Config</a>
            <a className="hover:text-zinc-900" href="/api/v1/models" target="_blank" rel="noreferrer">Models</a>
          </div>
        </div>
      </footer>
    </div>
  )
}

function StatusBadge({ status }: { status: Status }) {
  const map: Record<Status, { label: string; cls: string }> = {
    idle: { label: "Idle", cls: "bg-zinc-100 text-zinc-600 border-zinc-200" },
    sending: { label: "Sending", cls: "bg-amber-50 text-amber-700 border-amber-200" },
    streaming: { label: "Streaming", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
    done: { label: "Done", cls: "bg-zinc-100 text-zinc-700 border-zinc-200" },
    error: { label: "Error", cls: "bg-red-50 text-red-700 border-red-200" },
  }
  const s = map[status]
  return (
    <Badge variant="outline" className={`text-[10px] ${s.cls}`}>
      {s.label}
    </Badge>
  )
}
