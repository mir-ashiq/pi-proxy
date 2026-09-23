/**
 * Format converter: translates between OpenAI Chat Completions and
 * Anthropic Messages wire formats.
 *
 * This is what makes the Pi proxy a true *gateway* rather than a simple
 * pass-through. A client can send an OpenAI-format request, and if the
 * matched provider speaks Anthropic (or vice versa), this module converts
 * the request body, then converts the streaming/non-streaming response
 * back into the client's expected format.
 *
 * Conversions supported:
 *   - Request body:  OpenAI → Anthropic, Anthropic → OpenAI
 *   - Response (non-streaming): OpenAI → Anthropic, Anthropic → OpenAI
 *   - Response (streaming SSE):  OpenAI → Anthropic, Anthropic → OpenAI
 *
 * The streaming converters use TransformStream to parse incoming SSE
 * events and re-emit them in the target format with minimal buffering.
 */

import type { WireFormat } from "@/lib/pi-config";

/* ------------------------------------------------------------------ */
/* Type helpers                                                        */
/* ------------------------------------------------------------------ */

interface OpenAIMessage {
  role: string;
  content: string | unknown;
  name?: string;
}

interface OpenAIRequestBody {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stop?: string | string[];
  [k: string]: unknown;
}

interface AnthropicMessage {
  role: string;
  content:
    | string
    | Array<{ type: string; text?: string; [k: string]: unknown }>;
}

interface AnthropicRequestBody {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: string; text: string }>;
  stream?: boolean;
  temperature?: number;
  max_tokens: number;
  top_p?: number;
  stop_sequences?: string[];
  [k: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* Request conversion                                                  */
/* ------------------------------------------------------------------ */

/** Extract a plain-text user message from an OpenAI content field. */
function openAIContentToString(content: OpenAIMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: unknown) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && "text" in b) {
          return String((b as { text: unknown }).text ?? "");
        }
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

/**
 * Convert an OpenAI Chat Completions request body to an Anthropic
 * Messages request body.
 *
 * - System messages are extracted into the `system` field.
 * - Tool/assistant messages keep their roles.
 * - `max_tokens` defaults to 1024 if missing (Anthropic requires it).
 */
export function openAIRequestToAnthropic(
  body: OpenAIRequestBody,
): AnthropicRequestBody {
  const systemParts: string[] = [];
  const messages: AnthropicMessage[] = [];

  for (const m of body.messages) {
    if (m.role === "system") {
      const txt = openAIContentToString(m.content);
      if (txt) systemParts.push(txt);
      continue;
    }
    const text = openAIContentToString(m.content);
    messages.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content: text,
    });
  }

  return {
    model: body.model,
    max_tokens: body.max_tokens || 1024,
    messages,
    ...(systemParts.length ? { system: systemParts.join("\n\n") } : {}),
    ...(body.stream !== undefined ? { stream: body.stream } : {}),
    ...(body.temperature !== undefined
      ? { temperature: body.temperature }
      : {}),
    ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
    ...(body.stop
      ? {
          stop_sequences: Array.isArray(body.stop) ? body.stop : [body.stop],
        }
      : {}),
  };
}

/**
 * Convert an Anthropic Messages request body to an OpenAI Chat
 * Completions request body.
 *
 * - The `system` field becomes a leading `{role: "system"}` message.
 * - Content blocks are flattened to strings.
 */
export function anthropicRequestToOpenAI(
  body: AnthropicRequestBody,
): OpenAIRequestBody {
  const messages: OpenAIMessage[] = [];

  if (body.system) {
    const sys =
      typeof body.system === "string"
        ? body.system
        : body.system.map((b) => b.text).join("\n\n");
    messages.push({ role: "system", content: sys });
  }

  for (const m of body.messages) {
    const text = Array.isArray(m.content)
      ? m.content
          .map((b) => (b.type === "text" ? b.text || "" : ""))
          .filter(Boolean)
          .join(" ")
      : m.content;
    messages.push({ role: m.role, content: text });
  }

  return {
    model: body.model,
    messages,
    ...(body.stream !== undefined ? { stream: body.stream } : {}),
    ...(body.temperature !== undefined
      ? { temperature: body.temperature }
      : {}),
    ...(body.max_tokens !== undefined ? { max_tokens: body.max_tokens } : {}),
    ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
    ...(body.stop_sequences ? { stop: body.stop_sequences } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Non-streaming response conversion                                   */
/* ------------------------------------------------------------------ */

interface OpenAIChoice {
  index: number;
  message: { role: string; content: string };
  finish_reason: string | null;
}

interface OpenAIResponse {
  id: string;
  model: string;
  choices: OpenAIChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface AnthropicBlock {
  type: string;
  text?: string;
}

interface AnthropicResponse {
  id: string;
  model: string;
  content: AnthropicBlock[];
  stop_reason: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

/** Convert an OpenAI non-streaming response to Anthropic format. */
export function openAIResponseToAnthropic(
  body: OpenAIResponse,
): AnthropicResponse {
  const choice = body.choices?.[0];
  const text = choice?.message?.content || "";
  return {
    id: body.id,
    model: body.model,
    type: "message" as const,
    role: "assistant" as const,
    content: [{ type: "text", text }],
    stop_reason: choice?.finish_reason === "stop" ? "end_turn" : choice?.finish_reason || null,
    stop_sequence: null,
    usage: {
      input_tokens: body.usage?.prompt_tokens || 0,
      output_tokens: body.usage?.completion_tokens || 0,
    },
  };
}

/** Convert an Anthropic non-streaming response to OpenAI format. */
export function anthropicResponseToOpenAI(
  body: AnthropicResponse,
): OpenAIResponse {
  const text = (body.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text || "")
    .join("");
  return {
    id: body.id,
    object: "chat.completion" as const,
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason:
          body.stop_reason === "end_turn" ? "stop" : body.stop_reason || "stop",
      },
    ],
    usage: {
      prompt_tokens: body.usage?.input_tokens || 0,
      completion_tokens: body.usage?.output_tokens || 0,
      total_tokens:
        (body.usage?.input_tokens || 0) + (body.usage?.output_tokens || 0),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Streaming SSE conversion                                             */
/* ------------------------------------------------------------------ */

const enc = new TextEncoder();

/**
 * Convert an OpenAI SSE stream (chat.completion.chunk events) into an
 * Anthropic SSE stream (message_start → content_block_delta* → message_stop).
 *
 * Reads OpenAI `data: {...}` lines, extracts content deltas, and emits
 * the Anthropic event sequence. Handles `[DONE]` terminator.
 */
export function openAIStreamToAnthropicStream(
  upstream: Response,
  model: string,
): Response {
  const reader = (upstream.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let started = false;
  const messageId = `msg_proxy_${Date.now().toString(36)}`;
  let inputTokens = 0;
  let outputTokens = 0;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        // Emit closing events if we started a content block.
        if (started) {
          controller.enqueue(
            enc.encode(
              `event: content_block_stop\ndata: ${JSON.stringify({
                type: "content_block_stop",
                index: 0,
              })}\n\n`,
            ),
          );
          controller.enqueue(
            enc.encode(
              `event: message_delta\ndata: ${JSON.stringify({
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: outputTokens },
              })}\n\n`,
            ),
          );
          controller.enqueue(
            enc.encode(
              `event: message_stop\ndata: ${JSON.stringify({
                type: "message_stop",
              })}\n\n`,
            ),
          );
        }
        controller.close();
        return;
      }

      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") {
          controller.close();
          return;
        }
        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{
              delta?: { role?: string; content?: string };
              finish_reason?: string | null;
            }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          // Capture usage if present.
          if (json.usage?.prompt_tokens) inputTokens = json.usage.prompt_tokens;
          if (json.usage?.completion_tokens)
            outputTokens = json.usage.completion_tokens;

          const delta = json.choices?.[0]?.delta;
          const content = delta?.content;

          if (!started) {
            // Emit message_start + content_block_start.
            controller.enqueue(
              enc.encode(
                `event: message_start\ndata: ${JSON.stringify({
                  type: "message_start",
                  message: {
                    id: messageId,
                    type: "message",
                    role: "assistant",
                    content: [],
                    model,
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: inputTokens, output_tokens: 0 },
                  },
                })}\n\n`,
              ),
            );
            controller.enqueue(
              enc.encode(
                `event: content_block_start\ndata: ${JSON.stringify({
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "text", text: "" },
                })}\n\n`,
              ),
            );
            started = true;
          }

          if (content) {
            outputTokens += Math.ceil(content.length / 4);
            controller.enqueue(
              enc.encode(
                `event: content_block_delta\ndata: ${JSON.stringify({
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: content },
                })}\n\n`,
              ),
            );
          }
        } catch {
          // ignore non-JSON lines
        }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

/**
 * Convert an Anthropic SSE stream into an OpenAI SSE stream
 * (chat.completion.chunk events ending with `data: [DONE]`).
 *
 * Parses Anthropic `event:` / `data:` pairs, extracts `content_block_delta`
 * text, and re-emits as OpenAI chunks.
 */
export function anthropicStreamToOpenAIStream(
  upstream: Response,
  model: string,
): Response {
  const reader = (upstream.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let started = false;
  const id = `chatcmpl_proxy_${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        if (!started) {
          // Emit at least one empty chunk so the client doesn't hang.
          controller.enqueue(
            enc.encode(
              `data: ${JSON.stringify({
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [
                  { index: 0, delta: { role: "assistant" }, finish_reason: null },
                ],
              })}\n\n`,
            ),
          );
        }
        controller.enqueue(
          enc.encode(
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                { index: 0, delta: {}, finish_reason: "stop" },
              ],
            })}\n\n`,
          ),
        );
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
        return;
      }

      buf += decoder.decode(value, { stream: true });
      // SSE events are separated by blank lines.
      const events = buf.split("\n\n");
      buf = events.pop() || "";

      for (const evt of events) {
        const lines = evt.split("\n");
        let dataLine = "";
        for (const l of lines) {
          if (l.startsWith("data:")) dataLine = l.slice(5).trim();
        }
        if (!dataLine) continue;
        try {
          const json = JSON.parse(dataLine) as {
            type?: string;
            delta?: { type?: string; text?: string };
          };
          if (!started) {
            controller.enqueue(
              enc.encode(
                `data: ${JSON.stringify({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [
                    { index: 0, delta: { role: "assistant" }, finish_reason: null },
                  ],
                })}\n\n`,
              ),
            );
            started = true;
          }
          if (
            json.type === "content_block_delta" &&
            json.delta?.type === "text_delta" &&
            json.delta.text
          ) {
            controller.enqueue(
              enc.encode(
                `data: ${JSON.stringify({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [
                    { index: 0, delta: { content: json.delta.text }, finish_reason: null },
                  ],
                })}\n\n`,
              ),
            );
          }
        } catch {
          // ignore non-JSON
        }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

/* ------------------------------------------------------------------ */
/* Top-level dispatcher                                                 */
/* ------------------------------------------------------------------ */

/**
 * Decide whether conversion is needed between the client's request
 * format and the upstream provider's wire format.
 *
 * Returns one of:
 *   - "none"          — same format, no conversion needed
 *   - "openai→anthropic" — convert OpenAI request to Anthropic upstream
 *   - "anthropic→openai" — convert Anthropic request to OpenAI upstream
 */
export function conversionNeeded(
  clientFormat: WireFormat,
  providerFormat: WireFormat,
): "none" | "openai→anthropic" | "anthropic→openai" {
  if (clientFormat === providerFormat) return "none";
  return clientFormat === "openai" ? "openai→anthropic" : "anthropic→openai";
}

/**
 * Convert a request body from the client's format to the provider's format.
 * `conversion` should be the result of `conversionNeeded(...)`.
 */
export function convertRequestBody(
  body: unknown,
  conversion: "none" | "openai→anthropic" | "anthropic→openai",
): unknown {
  if (conversion === "none") return body;
  if (conversion === "openai→anthropic") {
    return openAIRequestToAnthropic(body as OpenAIRequestBody);
  }
  return anthropicRequestToOpenAI(body as AnthropicRequestBody);
}

/**
 * Convert a non-streaming upstream response back to the client's format.
 */
export function convertResponseBody(
  body: unknown,
  conversion: "none" | "openai→anthropic" | "anthropic→openai",
): unknown {
  if (conversion === "none") return body;
  if (conversion === "openai→anthropic") {
    // Upstream is OpenAI, client wants Anthropic.
    return openAIResponseToAnthropic(body as OpenAIResponse);
  }
  // Upstream is Anthropic, client wants OpenAI.
  return anthropicResponseToOpenAI(body as AnthropicResponse);
}

/**
 * Wrap an upstream streaming response, converting its SSE format back to
 * the client's expected format. For `conversion === "none"`, the response
 * is returned unchanged (byte-for-byte passthrough).
 */
export function convertStreamResponse(
  upstream: Response,
  conversion: "none" | "openai→anthropic" | "anthropic→openai",
  model: string,
): Response {
  if (conversion === "none") return upstream;
  if (conversion === "openai→anthropic") {
    return openAIStreamToAnthropicStream(upstream, model);
  }
  return anthropicStreamToOpenAIStream(upstream, model);
}
