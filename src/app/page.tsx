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
import { Copy, Check, Send, Loader2, CircleCheck, TriangleAlert, Zap, BookOpen, ArrowRight, Server, Key, Settings2 } from "lucide-react"

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

type ApiFormat = "openai" | "anthropic"
type Status = "idle" | "sending" | "streaming" | "done" | "error"

interface ProviderInfo {
  name: string
  baseUrl: string
  api: string
  format: ApiFormat
  apiKey_preview: string
  apiKey_configured: boolean
  apiKey_source: string
  models: Array<{ id: string; name: string }>
  has_cookie: boolean
}

interface ModelInfo {
  id: string
  name: string
  providers: Array<{ name: string; format: ApiFormat }>
  formats: ApiFormat[]
}

interface ConfigResponse {
  version: string
  config_source: string
  config_loaded_at: string
  config_error: string | null
  providers: ProviderInfo[]
  models: ModelInfo[]
  endpoints: Record<string, unknown>
  demo_mode: boolean
}

const PROXY_VERSION = "2.0.0"

const ENDPOINTS = [
  { label: "OpenAI Chat Completions", path: "/api/v1/chat/completions", method: "POST", format: "OpenAI" },
  { label: "Anthropic Messages", path: "/api/v1/messages", method: "POST", format: "Anthropic" },
  { label: "Models", path: "/api/v1/models", method: "GET", format: "OpenAI" },
  { label: "Health", path: "/api/health", method: "GET", format: "—" },
  { label: "Config", path: "/api/config", method: "GET", format: "—" },
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

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function Home() {
  const [config, setConfig] = useState<ConfigResponse | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)

  // Tester state
  const [format, setFormat] = useState<ApiFormat>("openai")
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
  const [providerUsed, setProviderUsed] = useState<string>("")
  const [conversionUsed, setConversionUsed] = useState<string>("")

  const abortRef = useRef<AbortController | null>(null)
  const rawRef = useRef<HTMLPreElement | null>(null)

  /* Load config on mount */
  useEffect(() => {
    let cancelled = false
    fetch("/api/config")
      .then((r) => r.json())
      .then((data: ConfigResponse) => {
        if (cancelled) return
        setConfig(data)
        if (data.models.length > 0) {
          setSelectedModel(data.models[0].id)
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setConfigError(e instanceof Error ? e.message : String(e))
      })
    return () => { cancelled = true }
  }, [])

  // Models available for the current format
  const availableModels = useMemo(
    () => config?.models || [],
    [config],
  )

  // The effective model (auto-pick if current selection isn't in the list)
  const effectiveModel = useMemo(() => {
    if (availableModels.length === 0) return selectedModel
    return availableModels.find((m) => m.id === selectedModel)
      ? selectedModel
      : availableModels[0].id
  }, [availableModels, selectedModel])

  // Which provider will be used for effectiveModel?
  const routing = useMemo(() => {
    const m = availableModels.find((m) => m.id === effectiveModel)
    if (!m) return null
    const sameFormat = m.providers.find((p) => p.format === format)
    const provider = sameFormat || m.providers[0]
    const conversion = sameFormat ? "none" : `${format}→${provider.format}`
    return { model: m, provider, conversion }
  }, [availableModels, effectiveModel, format])

  /* ---- Send ---- */
  const send = useCallback(async () => {
    if (status === "sending" || status === "streaming") return
    setStatus("sending")
    setRendered("")
    setRawSse("")
    setErrorText("")
    setLatencyMs(null)
    setProviderUsed("")
    setConversionUsed("")

    const controller = new AbortController()
    abortRef.current = controller
    const started = performance.now()

    const path = format === "openai" ? "/api/v1/chat/completions" : "/api/v1/messages"
    const body =
      format === "openai"
        ? {
            model: effectiveModel,
            messages: [
              ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
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
          ...(format === "anthropic" ? { "anthropic-version": "2023-06-01" } : {}),
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

    // Capture routing metadata from response headers
    setProviderUsed(res.headers.get("x-pi-proxy-provider") || "")
    setConversionUsed(res.headers.get("x-pi-proxy-conversion") || "")

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      setStatus("error")
      setErrorText(`HTTP ${res.status} — ${text || res.statusText}`)
      return
    }

    if (!stream) {
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

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        setRawSse((prev) => prev + chunk)
        buf += chunk
        const lines = buf.split("\n")
        buf = lines.pop() || ""
        for (const line of lines) {
          const trimmed = line.trim()
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
              if (json?.type === "content_block_delta" && json?.delta?.text) {
                acc += json.delta.text
                setRendered(acc)
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

  useEffect(() => {
    if (rawRef.current) {
      rawRef.current.scrollTop = rawRef.current.scrollHeight
    }
  }, [rawSse])

  /* ---- Curl command ---- */
  const curlCommand = useMemo(() => {
    const path = format === "openai" ? "/api/v1/chat/completions" : "/api/v1/messages"
    const body =
      format === "openai"
        ? {
            model: effectiveModel,
            messages: [
              ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
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
    const headerLine = format === "anthropic" ? `-H "anthropic-version: 2023-06-01"` : ""
    const demoLine = demoMode ? `-H "x-pi-demo: 1"` : ""
    const headers = [
      `-H "Content-Type: application/json"`,
      headerLine,
      demoLine,
    ].filter(Boolean)
    return [
      `curl -X POST '${path}' \\`,
      ...headers.map((h) => `  ${h} \\`),
      `  -d '${JSON.stringify(body)}'`,
    ].join("\n")
  }, [demoMode, format, maxTokens, effectiveModel, stream, systemPrompt, temperature, userMessage])

  /* ---- Pi config snippet ---- */
  const piConfigSnippet = useMemo(() => {
    const providers = config?.providers || []
    if (providers.length === 0) {
      return `{\n  "providers": {\n    "Your-Provider": {\n      "baseUrl": "https://api.openai.com/v1",\n      "api": "openai-completions",\n      "apiKey": "$OPENAI_API_KEY",\n      "models": [\n        { "id": "gpt-4", "name": "gpt-4" }\n      ]\n    }\n  }\n}`
    }
    // Show a redacted version of the actual config
    const redacted: Record<string, unknown> = {}
    for (const p of providers) {
      redacted[p.name] = {
        baseUrl: p.baseUrl,
        api: p.api,
        apiKey: p.apiKey_source.startsWith("env:") ? `$${p.apiKey_source.slice(4)}` : "(literal)",
        models: p.models.map((m) => ({ id: m.id, name: m.name })),
      }
    }
    return JSON.stringify({ providers: redacted }, null, 2)
  }, [config])

  return (
    <div className="min-h-screen flex flex-col bg-zinc-50 text-zinc-900">
      {/* Header */}
      <header className="sticky top-0 z-30 backdrop-blur-md bg-white/85 border-b border-zinc-200">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="size-8 rounded-md bg-amber-600 text-white font-serif font-bold flex items-center justify-center text-lg shadow-sm">π</div>
            <div className="leading-tight">
              <div className="font-semibold text-sm">Pi Proxy Server</div>
              <div className="text-[11px] text-zinc-500 font-mono">v{PROXY_VERSION} · config-driven gateway</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="hidden sm:inline-flex text-[11px] gap-1">
              <span className={`size-1.5 rounded-full ${config ? "bg-emerald-500 animate-pulse" : "bg-zinc-400"}`} />
              {config ? `${config.providers.length} providers` : "Loading…"}
            </Badge>
            <a href="https://agentrouter.org/docs/pi.html" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-xs text-zinc-600 hover:text-zinc-900 px-2.5 py-1.5 rounded-md hover:bg-zinc-100 transition-colors">
              <BookOpen className="size-3.5" />
              <span className="hidden sm:inline">Pi Docs</span>
            </a>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-8 sm:py-12 space-y-10">
        {/* Hero */}
        <section className="text-center space-y-4 pt-2">
          <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 font-mono">
            OpenAI · Anthropic · Pi-compatible · config-driven
          </Badge>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">Pi Proxy Server</h1>
          <p className="text-base sm:text-lg text-zinc-600 max-w-2xl mx-auto">
            A gateway that reads your Pi config and exposes every provider as a unified OpenAI + Anthropic API.
            Configure once in <code className="font-mono text-xs bg-zinc-100 px-1 py-0.5 rounded">~/.pi/agent/models.json</code>, use everywhere.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
            <Button asChild><a href="#tester"><Zap className="size-4" /> Try it live</a></Button>
            <Button asChild variant="outline"><a href="#architecture">How it works</a></Button>
          </div>
        </section>

        {/* Architecture diagram */}
        <section id="architecture" className="space-y-4 scroll-mt-20">
          <div>
            <h2 className="text-xl font-semibold">How it works</h2>
            <p className="text-sm text-zinc-600">Three layers. Your providers stay in Pi, the proxy routes to them.</p>
          </div>
          <Card>
            <CardContent className="pt-6">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-stretch">
                {/* Layer 1: Pi config */}
                <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 flex flex-col gap-2">
                  <div className="flex items-center gap-2 text-xs font-semibold text-zinc-500 uppercase tracking-wider">
                    <Settings2 className="size-3.5" /> 1. Pi config
                  </div>
                  <div className="text-sm font-medium">~/.pi/agent/models.json</div>
                  <div className="text-xs text-zinc-600 leading-relaxed">
                    You list your real providers here — any baseUrl, any apiKey, any wire format. Pi stores them, the proxy reads them.
                  </div>
                  <div className="mt-auto pt-2 text-[10px] font-mono text-zinc-500 truncate">
                    {config?.config_source || "~/.pi/agent/models.json"}
                  </div>
                </div>

                {/* Arrow */}
                <div className="hidden md:flex items-center justify-center">
                  <ArrowRight className="size-5 text-zinc-400" />
                </div>

                {/* Layer 2: Proxy */}
                <div className="rounded-lg border-2 border-amber-300 bg-amber-50 p-4 flex flex-col gap-2">
                  <div className="flex items-center gap-2 text-xs font-semibold text-amber-700 uppercase tracking-wider">
                    <Server className="size-3.5" /> 2. Pi Proxy
                  </div>
                  <div className="text-sm font-medium">/api/v1/* endpoints</div>
                  <div className="text-xs text-amber-900 leading-relaxed">
                    Reads the config, routes each request to the matching provider by model name. Converts between OpenAI and Anthropic wire formats on the fly.
                  </div>
                  <div className="mt-auto pt-2 text-[10px] font-mono text-amber-700">
                    localhost:3000
                  </div>
                </div>

                {/* Arrow */}
                <div className="hidden md:flex items-center justify-center">
                  <ArrowRight className="size-5 text-zinc-400" />
                </div>

                {/* Layer 3: Upstreams */}
                <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 flex flex-col gap-2">
                  <div className="flex items-center gap-2 text-xs font-semibold text-zinc-500 uppercase tracking-wider">
                    <Key className="size-3.5" /> 3. Your providers
                  </div>
                  <div className="text-sm font-medium">OpenAI · Anthropic · AgentRouter · …</div>
                  <div className="text-xs text-zinc-600 leading-relaxed">
                    Any provider you configured in Pi. The proxy uses each provider&apos;s own baseUrl + apiKey — no central hardcoded upstream.
                  </div>
                  <div className="mt-auto pt-2 flex flex-wrap gap-1">
                    {(config?.providers || []).map((p) => (
                      <Badge key={p.name} variant="secondary" className="text-[10px] font-mono">{p.name}</Badge>
                    ))}
                    {(!config || config.providers.length === 0) && (
                      <span className="text-[10px] text-zinc-500 italic">none configured</span>
                    )}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* Status banner */}
        {configError && (
          <Alert variant="destructive">
            <TriangleAlert className="size-4" />
            <AlertTitle>Could not load proxy config</AlertTitle>
            <AlertDescription className="font-mono text-xs">{configError}</AlertDescription>
          </Alert>
        )}
        {config && config.config_error && (
          <Alert variant="destructive">
            <TriangleAlert className="size-4" />
            <AlertTitle>Pi config not found</AlertTitle>
            <AlertDescription className="text-xs">
              {config.config_error}. Create <code className="font-mono bg-red-50 px-1 py-0.5 rounded">~/.pi/agent/models.json</code> with at least one provider, or enable demo mode below.
            </AlertDescription>
          </Alert>
        )}
        {config && !config.config_error && config.providers.length > 0 && (
          <Alert className="border-emerald-200 bg-emerald-50 text-emerald-800">
            <CircleCheck className="size-4" />
            <AlertTitle>{config.providers.length} provider{config.providers.length === 1 ? "" : "s"} loaded</AlertTitle>
            <AlertDescription>
              {config.models.length} models available · config from <code className="font-mono text-[11px] bg-emerald-100 px-1 py-0.5 rounded">{config.config_source}</code>
            </AlertDescription>
          </Alert>
        )}
        <Alert className="border-amber-200 bg-amber-50 text-amber-900">
          <TriangleAlert className="size-4" />
          <AlertTitle>Demo mode — available as fallback</AlertTitle>
          <AlertDescription className="text-xs space-y-1">
            <p>
              If a real upstream is unreachable (WAF, network, etc.), turn on <strong>Demo mode</strong> in the tester below to verify the proxy plumbing with simulated SSE streams.
            </p>
          </AlertDescription>
        </Alert>

        {/* Configured providers */}
        {config && config.providers.length > 0 && (
          <section className="space-y-4">
            <div>
              <h2 className="text-xl font-semibold">Configured providers</h2>
              <p className="text-sm text-zinc-600">Read from your Pi config. API keys are masked.</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {config.providers.map((p) => (
                <Card key={p.name}>
                  <CardContent className="pt-5">
                    <div className="flex items-start justify-between gap-2 mb-3">
                      <div>
                        <div className="font-semibold text-sm font-mono">{p.name}</div>
                        <div className="text-xs text-zinc-500 font-mono truncate">{p.baseUrl}</div>
                      </div>
                      <Badge variant="outline" className={`text-[10px] ${p.format === "openai" ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-purple-50 text-purple-700 border-purple-200"}`}>
                        {p.api}
                      </Badge>
                    </div>
                    <div className="space-y-1 text-xs">
                      <div className="flex justify-between">
                        <span className="text-zinc-500">API key</span>
                        <span className="font-mono">{p.apiKey_preview}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-zinc-500">Key source</span>
                        <span className="font-mono">{p.apiKey_source}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-zinc-500">Models</span>
                        <span className="font-mono">{p.models.length}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-zinc-500">Cookie</span>
                        <span className="font-mono">{p.has_cookie ? "yes" : "no"}</span>
                      </div>
                    </div>
                    <Separator className="my-3" />
                    <div className="flex flex-wrap gap-1">
                      {p.models.slice(0, 6).map((m) => (
                        <Badge key={m.id} variant="secondary" className="text-[10px] font-mono">{m.id}</Badge>
                      ))}
                      {p.models.length > 6 && (
                        <Badge variant="outline" className="text-[10px]">+{p.models.length - 6}</Badge>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        )}

        {/* Routing table */}
        {config && config.models.length > 0 && (
          <section className="space-y-4">
            <div>
              <h2 className="text-xl font-semibold">Routing table</h2>
              <p className="text-sm text-zinc-600">How the proxy routes each model to its provider(s).</p>
            </div>
            <Card>
              <CardContent className="p-0 sm:p-2">
                <div className="divide-y divide-zinc-100">
                  {config.models.map((m) => (
                    <div key={m.id} className="flex items-center justify-between gap-3 py-2.5 px-2">
                      <code className="text-sm font-mono text-zinc-800 truncate">{m.id}</code>
                      <div className="flex items-center gap-1.5 flex-wrap justify-end">
                        {m.providers.map((p) => (
                          <Badge key={p.name} variant="outline" className={`text-[10px] ${p.format === "openai" ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-purple-50 text-purple-700 border-purple-200"}`}>
                            {p.name} · {p.format}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </section>
        )}

        {/* Endpoints */}
        <section className="space-y-4">
          <div>
            <h2 className="text-xl font-semibold">Endpoints</h2>
            <p className="text-sm text-zinc-600">Point any OpenAI or Anthropic SDK at these paths.</p>
          </div>
          <Card>
            <CardContent className="p-0 sm:p-2">
              {ENDPOINTS.map((ep) => (
                <div key={ep.path} className="flex items-center justify-between gap-3 py-2.5 px-2 border-b border-zinc-100 last:border-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <Badge variant="outline" className={`font-mono text-[10px] px-1.5 py-0 ${ep.method === "POST" ? "bg-amber-50 text-amber-700 border-amber-200" : "bg-emerald-50 text-emerald-700 border-emerald-200"}`}>
                      {ep.method}
                    </Badge>
                    <code className="text-sm font-mono text-zinc-800 truncate">{ep.path}</code>
                  </div>
                  <Badge variant="secondary" className="text-[10px] whitespace-nowrap">{ep.format}</Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        </section>

        {/* Quick start */}
        <section className="space-y-4">
          <div>
            <h2 className="text-xl font-semibold">Quick start</h2>
            <p className="text-sm text-zinc-600">The proxy uses API keys from your Pi config — no separate auth needed.</p>
          </div>
          <Tabs defaultValue="openai">
            <TabsList className="w-full justify-start">
              <TabsTrigger value="openai">OpenAI SDK</TabsTrigger>
              <TabsTrigger value="anthropic">Anthropic SDK</TabsTrigger>
              <TabsTrigger value="curl">curl</TabsTrigger>
              <TabsTrigger value="pi">Pi config</TabsTrigger>
            </TabsList>
            <TabsContent value="openai" className="mt-4 space-y-3">
              <p className="text-sm text-zinc-600">Point any OpenAI client at <code className="font-mono text-xs bg-zinc-100 px-1 py-0.5 rounded">base_url=&quot;/api/v1&quot;</code>. The proxy routes by model name to whatever provider you configured.</p>
              <CodeBlock id="openai-sdk" lang="python" code={`from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/api/v1",
    api_key="any-string",  # proxy uses keys from your Pi config
)

resp = client.chat.completions.create(
    model="deepseek-v4-flash",
    messages=[{"role": "user", "content": "Say hi in 5 words."}],
)
print(resp.choices[0].message.content)`} />
            </TabsContent>
            <TabsContent value="anthropic" className="mt-4 space-y-3">
              <p className="text-sm text-zinc-600">Point the Anthropic SDK at <code className="font-mono text-xs bg-zinc-100 px-1 py-0.5 rounded">base_url=&quot;/api&quot;</code>.</p>
              <CodeBlock id="anthropic-sdk" lang="python" code={`from anthropic import Anthropic

client = Anthropic(
    base_url="http://localhost:3000/api",
    api_key="any-string",  # proxy uses keys from your Pi config
)

msg = client.messages.create(
    model="claude-opus-4-8",
    max_tokens=512,
    messages=[{"role": "user", "content": "Say hi in 5 words."}],
)
print(msg.content[0].text)`} />
            </TabsContent>
            <TabsContent value="curl" className="mt-4 space-y-3">
              <p className="text-sm text-zinc-600">Try the proxy with curl:</p>
              <CodeBlock id="curl-cmd" lang="bash" code={curlCommand} />
            </TabsContent>
            <TabsContent value="pi" className="mt-4 space-y-3">
              <p className="text-sm text-zinc-600">Your <code className="font-mono text-xs bg-zinc-100 px-1 py-0.5 rounded">~/.pi/agent/models.json</code> (currently loaded config, redacted):</p>
              <CodeBlock id="pi-config" lang="json" code={piConfigSnippet} />
            </TabsContent>
          </Tabs>
        </section>

        {/* Live tester */}
        <section id="tester" className="space-y-4 scroll-mt-20">
          <div>
            <h2 className="text-xl font-semibold">Live tester</h2>
            <p className="text-sm text-zinc-600">
              Send a real request. {routing && (
                <>Will route to <strong className="font-mono text-xs">{routing.provider.name}</strong> ({routing.provider.format}){routing.conversion !== "none" && <> with <strong className="font-mono text-xs">{routing.conversion}</strong> conversion</>}.
              </>
            )}
            </p>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
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
                <CardDescription className="text-xs">POST {format === "openai" ? "/api/v1/chat/completions" : "/api/v1/messages"}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="model" className="text-xs">Model</Label>
                  <Select value={effectiveModel} onValueChange={setSelectedModel}>
                    <SelectTrigger id="model" className="h-9"><SelectValue placeholder="Pick a model" /></SelectTrigger>
                    <SelectContent>
                      {availableModels.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          <span className="font-mono">{m.name}</span>
                          <span className="ml-2 text-xs text-zinc-500">{m.providers.map((p) => p.format).join("+")}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="system" className="text-xs">System prompt</Label>
                  <Textarea id="system" rows={2} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} className="text-sm resize-y" placeholder="You are a helpful assistant." />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="user" className="text-xs">User message</Label>
                  <Textarea id="user" rows={4} value={userMessage} onChange={(e) => setUserMessage(e.target.value)} className="text-sm resize-y" placeholder="Ask anything…" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Temperature: {temperature.toFixed(2)}</Label>
                    <Slider value={[temperature]} min={0} max={2} step={0.05} onValueChange={(v) => setTemperature(v[0] ?? 0.7)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="max" className="text-xs">Max tokens</Label>
                    <Input id="max" type="number" min={1} max={8192} value={maxTokens} onChange={(e) => setMaxTokens(Number(e.target.value) || 0)} className="h-9" />
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
                      <Button variant="outline" size="sm" onClick={cancel}>Cancel</Button>
                    )}
                    <Button size="sm" onClick={send} disabled={status === "sending" || status === "streaming" || !userMessage.trim()}>
                      {status === "sending" || status === "streaming" ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
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
            <Card className="flex flex-col">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Response</CardTitle>
                  <div className="flex items-center gap-2 flex-wrap justify-end">
                    {providerUsed && <Badge variant="secondary" className="text-[10px] font-mono">{providerUsed}</Badge>}
                    {conversionUsed && conversionUsed !== "none" && <Badge variant="outline" className="text-[10px] font-mono bg-amber-50 text-amber-700 border-amber-200">{conversionUsed}</Badge>}
                    {latencyMs !== null && <Badge variant="secondary" className="text-[10px] font-mono">{latencyMs} ms</Badge>}
                    <StatusBadge status={status} />
                  </div>
                </div>
                <CardDescription className="text-xs">Rendered output · streaming updates in real time</CardDescription>
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
                    <span className="text-xs font-medium text-zinc-600">Raw SSE stream</span>
                  </div>
                  <pre ref={rawRef} className="bg-zinc-950 text-zinc-300 rounded-md p-3 text-[11px] font-mono overflow-auto max-h-48 min-h-[120px] leading-relaxed">
                    {rawSse || <span className="text-zinc-600 italic">SSE chunks will appear here…</span>}
                  </pre>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>
      </main>

      <footer className="mt-auto border-t border-zinc-200 bg-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs text-zinc-500">
          <div className="flex items-center gap-2">
            <div className="size-5 rounded bg-amber-600 text-white font-serif font-bold flex items-center justify-center text-xs">π</div>
            <span>Pi Proxy Server · v{PROXY_VERSION} · config-driven gateway · <a className="underline hover:text-zinc-900" href="https://agentrouter.org/docs/pi.html" target="_blank" rel="noreferrer">Pi docs</a></span>
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
  return <Badge variant="outline" className={`text-[10px] ${s.cls}`}>{s.label}</Badge>
}
