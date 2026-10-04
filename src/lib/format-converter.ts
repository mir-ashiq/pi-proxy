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
 * v2.1 — the converter is now lossless for the content classes agent
 * traffic actually uses. The v2.0 converter silently dropped:
 *
 *   - reasoning / thinking content (assistant `reasoning_content` fields
 *     and Anthropic `thinking` blocks, streaming and non-streaming) — the
 *     drop made strict thinking-mode channels (z.ai GLM behind relays)
 *     reject every replay, because the client never saw the reasoning it
 *     was later required to send back;
 *   - tool calling (OpenAI `tools`/`tool_calls`/`role:"tool"` and
 *     Anthropic `tool_use`/`tool_result`) — agents could not call tools
 *     at all through a converted route;
 *   - images;
 *   - usage accounting in streaming conversions;
 *   - terminal SSE events (the OpenAI→Anthropic stream closed without
 *     content_block_stop / message_delta / message_stop on [DONE]).
 *
 * Mapping summary (OpenAI ← → Anthropic):
 *
 *   message.reasoning_content            ←→ content[].{type:"thinking"}
 *   message.tool_calls[]                 ←→ content[].{type:"tool_use"}
 *   role:"tool" (tool_call_id)           ←→ user content[].{type:"tool_result"}
 *   tools[].function.{name,description,
 *     parameters}                        ←→ tools[].{name,description,input_schema}
 *   finish_reason stop/length/tool_calls ←→ stop_reason end_turn/max_tokens/tool_use
 *   image_url (data:/http:)              ←→ image source base64/url
 *   reasoning_effort low/medium/high     →  thinking {type:"enabled",budget_tokens}
 *
 * The streaming converters use ReadableStream to parse incoming SSE
 * events and re-emit them in the target format with minimal buffering.
 */

import type { WireFormat } from "@/lib/pi-config";

/* ------------------------------------------------------------------ */
/* Type helpers                                                        */
/* ------------------------------------------------------------------ */

interface OpenAIToolCallFunction {
  name?: string;
  arguments?: string;
}

interface OpenAIToolCall {
  id?: string;
  index?: number;
  type?: string;
  function?: OpenAIToolCallFunction;
}

interface OpenAIMessage {
  role?: string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
  [k: string]: unknown;
}

interface OpenAIRequestBody {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  top_p?: number;
  top_k?: number;
  stop?: string | string[];
  tools?: unknown[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  reasoning_effort?: string;
  [k: string]: unknown;
}

interface AnthropicBlock {
  type: string;
  [k: string]: unknown;
}

interface AnthropicMessage {
  role: string;
  content: string | AnthropicBlock[];
  [k: string]: unknown;
}

interface AnthropicRequestBody {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: string; text: string }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: unknown;
  [k: string]: unknown;
}

/** Reasoning field spellings an OpenAI payload may speak (widest first). */
const REASONING_FIELDS = [
  "reasoning_content",
  "reasoning",
  "reasoning_text",
] as const;

function firstNonEmptyReasoning(message: OpenAIMessage): string | undefined {
  for (const field of REASONING_FIELDS) {
    const value = message[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function reasoningSignature(message: OpenAIMessage): string | undefined {
  for (const field of ["reasoning_signature", "thinking_signature"]) {
    const value = message[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Request conversion: OpenAI → Anthropic                              */
/* ------------------------------------------------------------------ */

/** Convert an OpenAI image_url part into an Anthropic image block. */
function openAIImagePartToAnthropicBlock(part: {
  image_url?: { url?: string };
}): AnthropicBlock | null {
  const url = part.image_url?.url;
  if (typeof url !== "string" || url.length === 0) return null;
  const dataMatch = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
  if (dataMatch) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: dataMatch[1],
        data: dataMatch[2],
      },
    };
  }
  return { type: "image", source: { type: "url", url } };
}

/** Convert one OpenAI content part / string into Anthropic blocks. */
function openAIContentPartToAnthropicBlocks(part: unknown): AnthropicBlock[] {
  if (typeof part === "string") {
    return part.length > 0 ? [{ type: "text", text: part }] : [];
  }
  if (!part || typeof part !== "object") return [];
  const block = part as { type?: string; [k: string]: unknown };
  if (block.type === "text" && typeof block.text === "string") {
    return block.text.length > 0 ? [{ type: "text", text: block.text }] : [];
  }
  if (block.type === "image_url") {
    const image = openAIImagePartToAnthropicBlock(
      block as { image_url?: { url?: string } },
    );
    return image ? [image] : [];
  }
  if (block.type === "thinking" && typeof block.thinking === "string") {
    // Rare, but some stacks put thinking blocks in OpenAI content arrays.
    return [{ type: "thinking", thinking: block.thinking }];
  }
  return [];
}

function safeParseJSON(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { _raw: text };
  }
}

/** Convert OpenAI assistant tool_calls to Anthropic tool_use blocks. */
function openAIToolCallsToAnthropic(toolCalls: OpenAIToolCall[]): AnthropicBlock[] {
  const blocks: AnthropicBlock[] = [];
  for (let i = 0; i < toolCalls.length; i++) {
    const call = toolCalls[i];
    if (!call || typeof call !== "object") continue;
    blocks.push({
      type: "tool_use",
      id: typeof call.id === "string" && call.id ? call.id : `call_proxy_${i}`,
      name: call.function?.name || "unknown_tool",
      input: safeParseJSON(call.function?.arguments),
    });
  }
  return blocks;
}

/** Anthropic tool definition (note: no `type` field — unlike content blocks). */
interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  [k: string]: unknown;
}

/** Convert an OpenAI tools array to the Anthropic tools shape. */
function openAIToolsToAnthropic(tools: unknown[]): AnthropicTool[] {
  const out: AnthropicTool[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const t = tool as Record<string, unknown>;
    if (t.type === "function" && t.function && typeof t.function === "object") {
      const fn = t.function as Record<string, unknown>;
      out.push({
        name: String(fn.name ?? "unknown_tool"),
        description: String(fn.description ?? ""),
        input_schema:
          (fn.parameters as Record<string, unknown>) ?? {
            type: "object",
            properties: {},
          },
      });
    } else if (typeof t.name === "string") {
      // Already Anthropic-shaped (or z.ai-style); pass through.
      out.push(t as AnthropicTool);
    }
  }
  return out;
}

/** Map an OpenAI tool_choice to the Anthropic tool_choice shape. */
function openAIToolChoiceToAnthropic(choice: unknown): unknown {
  if (choice === "auto") return { type: "auto" };
  if (choice === "required") return { type: "any" };
  if (choice === "none") return { type: "none" };
  if (choice && typeof choice === "object") {
    const c = choice as Record<string, unknown>;
    if (c.type === "function" && c.function && typeof c.function === "object") {
      const fn = c.function as Record<string, unknown>;
      if (typeof fn.name === "string") return { type: "tool", name: fn.name };
    }
    if (c.type === "function" && typeof c.name === "string") {
      return { type: "tool", name: c.name };
    }
  }
  return undefined;
}

/** Map reasoning_effort (+ optional explicit thinking) to an Anthropic thinking param. */
function openAIReasoningToAnthropicThinking(
  body: OpenAIRequestBody,
  maxTokens: number,
): Record<string, unknown> | undefined {
  // An explicit Anthropic-style thinking object passes through untouched.
  if (body.thinking && typeof body.thinking === "object") {
    return body.thinking as Record<string, unknown>;
  }
  const effort = body.reasoning_effort;
  if (typeof effort !== "string" || effort === "" || effort === "none" || effort === "off") {
    return undefined;
  }
  const budgetByEffort: Record<string, number> = {
    low: 2048,
    medium: 8192,
    high: 16384,
  };
  const budget = budgetByEffort[effort] ?? 8192;
  // Anthropic requires 1024 <= budget_tokens < max_tokens; when the
  // request's max_tokens is too small to express a budget, omit the
  // thinking param entirely rather than send an invalid one.
  if (maxTokens - 512 < 1024) return undefined;
  const clamped = Math.max(1024, Math.min(budget, maxTokens - 512));
  return { type: "enabled", budget_tokens: clamped };
}

/**
 * Convert an OpenAI Chat Completions request body to an Anthropic
 * Messages request body.
 *
 * - System/developer messages are extracted into the `system` field.
 * - Assistant `reasoning_content`/`reasoning`/`reasoning_text` becomes a
 *   leading `thinking` content block (strict thinking-mode channels
 *   require replayed reasoning in exactly this shape).
 * - OpenAI `tool_calls` become `tool_use` blocks; `role:"tool"` messages
 *   become `tool_result` blocks grouped into the following user turn.
 * - Image parts (data URLs and http URLs) become Anthropic image blocks.
 * - `reasoning_effort` maps to the Anthropic `thinking` parameter.
 * - Consecutive same-role messages are merged (Anthropic expects
 *   user/assistant alternation).
 */
export function openAIRequestToAnthropic(
  body: OpenAIRequestBody,
): AnthropicRequestBody {
  const systemParts: string[] = [];
  const messages: AnthropicMessage[] = [];
  /** Pending tool_result blocks waiting to be merged into the next user turn. */
  let pendingToolResults: AnthropicBlock[] = [];

  const flushToolResults = () => {
    if (pendingToolResults.length === 0) return;
    messages.push({ role: "user", content: pendingToolResults });
    pendingToolResults = [];
  };

  const pushMerged = (role: "user" | "assistant", blocks: AnthropicBlock[]) => {
    if (blocks.length === 0) return;
    const last = messages[messages.length - 1];
    if (last && last.role === role && Array.isArray(last.content)) {
      last.content = [...last.content, ...blocks];
    } else {
      messages.push({ role, content: blocks });
    }
  };

  const openAIMessages = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of openAIMessages) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as OpenAIMessage;

    if (m.role === "system" || m.role === "developer") {
      const text = openAIContentToString(m.content);
      if (text) systemParts.push(text);
      continue;
    }

    if (m.role === "tool") {
      // Accumulate tool results; they become the leading blocks of the
      // next user turn (Anthropic's required shape).
      const blocks: AnthropicBlock[] = [];
      const content = m.content;
      if (typeof content === "string") {
        blocks.push(...openAIContentPartToAnthropicBlocks(content));
      } else if (Array.isArray(content)) {
        for (const part of content) {
          blocks.push(...openAIContentPartToAnthropicBlocks(part));
        }
      }
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id:
          typeof m.tool_call_id === "string" && m.tool_call_id
            ? m.tool_call_id
            : "toolu_unknown",
        content: blocks.length > 0 ? blocks : [{ type: "text", text: "" }],
      });
      continue;
    }

    if (m.role === "user") {
      const blocks: AnthropicBlock[] = [...pendingToolResults];
      pendingToolResults = [];
      if (typeof m.content === "string") {
        blocks.push(...openAIContentPartToAnthropicBlocks(m.content));
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          blocks.push(...openAIContentPartToAnthropicBlocks(part));
        }
      }
      pushMerged("user", blocks);
      continue;
    }

    // assistant (and anything else maps to assistant text)
    const blocks: AnthropicBlock[] = [];
    const reasoning = firstNonEmptyReasoning(m);
    if (reasoning !== undefined) {
      const signature = reasoningSignature(m);
      blocks.push({
        type: "thinking",
        thinking: reasoning,
        ...(signature !== undefined ? { signature } : {}),
      });
    }
    if (typeof m.content === "string") {
      if (m.content.length > 0) blocks.push({ type: "text", text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        blocks.push(...openAIContentPartToAnthropicBlocks(part));
      }
    }
    if (Array.isArray(m.tool_calls)) {
      blocks.push(...openAIToolCallsToAnthropic(m.tool_calls));
    }
    flushToolResults();
    if (blocks.length === 0) {
      // Anthropic rejects empty content and empty text blocks; keep the
      // turn positionally with a single space.
      pushMerged("assistant", [{ type: "text", text: " " }]);
    } else {
      pushMerged("assistant", blocks);
    }
  }
  flushToolResults();

  const maxTokens =
    (typeof body.max_tokens === "number" && body.max_tokens) ||
    (typeof body.max_completion_tokens === "number" &&
      (body.max_completion_tokens as number)) ||
    8192;

  const out: AnthropicRequestBody = {
    model: body.model,
    max_tokens: maxTokens,
    messages,
    ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}),
    ...(body.stream !== undefined ? { stream: body.stream } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
    ...(body.top_k !== undefined ? { top_k: body.top_k } : {}),
    ...(body.stop
      ? {
          stop_sequences: Array.isArray(body.stop) ? body.stop : [body.stop],
        }
      : {}),
  };

  if (Array.isArray(body.tools)) {
    const tools = openAIToolsToAnthropic(body.tools);
    if (tools.length > 0) out.tools = tools;
  }
  const toolChoice = openAIToolChoiceToAnthropic(body.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  if (body.parallel_tool_calls === false && Array.isArray(out.tools)) {
    out.tool_choice = { type: "auto", disable_parallel_tool_use: true };
  }
  const thinking = openAIReasoningToAnthropicThinking(body, maxTokens);
  if (thinking) out.thinking = thinking;

  return out;
}

/* ------------------------------------------------------------------ */
/* Request conversion: Anthropic → OpenAI                              */
/* ------------------------------------------------------------------ */

function anthropicImageBlockToOpenAIPart(block: AnthropicBlock): unknown | null {
  const source = block.source as Record<string, unknown> | undefined;
  if (!source || typeof source !== "object") return null;
  if (source.type === "base64") {
    return {
      type: "image_url",
      image_url: {
        url: `data:${source.media_type};base64,${source.data}`,
      },
    };
  }
  if (source.type === "url" && typeof source.url === "string") {
    return { type: "image_url", image_url: { url: source.url } };
  }
  return null;
}

/** Extract text from an Anthropic tool_result content (string or blocks). */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === "object" && (b as { type?: string }).type === "text"
          ? String((b as { text?: unknown }).text ?? "")
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Convert an Anthropic Messages request body to an OpenAI Chat
 * Completions request body.
 *
 * - `system` becomes a leading system message.
 * - Assistant `thinking` blocks become `reasoning_content`.
 * - `tool_use` blocks become `tool_calls`; leading `tool_result` blocks of
 *   user turns become `role:"tool"` messages.
 * - Image blocks become `image_url` parts (data URLs for base64 sources).
 * - The Anthropic `thinking` parameter passes through (GLM-style OpenAI
 *   endpoints accept it natively).
 */
export function anthropicRequestToOpenAI(
  body: AnthropicRequestBody,
): OpenAIRequestBody {
  const messages: OpenAIMessage[] = [];

  if (body.system) {
    const sys =
      typeof body.system === "string"
        ? body.system
        : body.system
            .map((b) => (typeof b?.text === "string" ? b.text : ""))
            .filter(Boolean)
            .join("\n\n");
    if (sys) messages.push({ role: "system", content: sys });
  }

  const anthropicMessages = Array.isArray(body.messages) ? body.messages : [];
  for (const m of anthropicMessages) {
    if (!m || typeof m !== "object") continue;

    if (!Array.isArray(m.content)) {
      messages.push({ role: m.role, content: m.content });
      continue;
    }

    // Leading tool_result blocks → separate role:"tool" messages first.
    let i = 0;
    while (i < m.content.length && m.content[i]?.type === "tool_result") {
      const block = m.content[i] as Record<string, unknown>;
      messages.push({
        role: "tool",
        tool_call_id: String(block.tool_use_id ?? "toolu_unknown"),
        content: toolResultText(block.content),
      });
      i++;
    }

    const reasoningParts: string[] = [];
    const contentParts: unknown[] = [];
    const toolCalls: OpenAIToolCall[] = [];
    for (; i < m.content.length; i++) {
      const block = m.content[i];
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string") {
        contentParts.push({ type: "text", text: block.text });
      } else if (block.type === "thinking" || block.type === "redacted_thinking") {
        const text =
          typeof block.thinking === "string" ? block.thinking : "(redacted)";
        if (text) reasoningParts.push(text);
      } else if (block.type === "image") {
        const part = anthropicImageBlockToOpenAIPart(block);
        if (part) contentParts.push(part);
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: typeof block.id === "string" ? block.id : undefined,
          type: "function",
          function: {
            name: typeof block.name === "string" ? block.name : "unknown_tool",
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      }
    }

    const isAssistant = m.role === "assistant";
    const message: OpenAIMessage = {
      role: m.role,
      content:
        contentParts.length === 0
          ? ""
          : contentParts.length === 1 &&
              (contentParts[0] as { type?: string }).type === "text"
            ? (contentParts[0] as { text: string }).text
            : contentParts,
    };
    if (isAssistant && reasoningParts.length > 0) {
      message.reasoning_content = reasoningParts.join("\n");
    }
    if (isAssistant && toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }
    messages.push(message);
  }

  const out: OpenAIRequestBody = {
    model: body.model,
    messages,
    ...(body.stream !== undefined ? { stream: body.stream } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.max_tokens !== undefined ? { max_tokens: body.max_tokens } : {}),
    ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
    ...(body.stop_sequences ? { stop: body.stop_sequences } : {}),
  };

  if (Array.isArray(body.tools)) {
    const tools: unknown[] = [];
    for (const tool of body.tools) {
      if (!tool || typeof tool !== "object") continue;
      const t = tool as Record<string, unknown>;
      if (typeof t.name === "string") {
        tools.push({
          type: "function",
          function: {
            name: t.name,
            description: String(t.description ?? ""),
            parameters:
              (t.input_schema as Record<string, unknown>) ?? {
                type: "object",
                properties: {},
              },
          },
        });
      } else if (t.type === "function" && t.function) {
        tools.push(t);
      }
    }
    if (tools.length > 0) out.tools = tools;
  }

  if (body.tool_choice && typeof body.tool_choice === "object") {
    const c = body.tool_choice as Record<string, unknown>;
    if (c.type === "auto") out.tool_choice = "auto";
    else if (c.type === "any") out.tool_choice = "required";
    else if (c.type === "none") out.tool_choice = "none";
    else if (c.type === "tool" && typeof c.name === "string") {
      out.tool_choice = { type: "function", function: { name: c.name } };
    }
  }

  if (body.thinking && typeof body.thinking === "object") {
    out.thinking = body.thinking;
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Shared small helpers                                                */
/* ------------------------------------------------------------------ */

/** Extract a plain-text string from an OpenAI content field. */
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

/** Map an Anthropic stop_reason to an OpenAI finish_reason. */
export function stopReasonToFinishReason(
  stopReason: string | null | undefined,
): string | null {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    case null:
    case undefined:
    case "":
      return null;
    default:
      return "stop";
  }
}

/** Map an OpenAI finish_reason to an Anthropic stop_reason. */
export function finishReasonToStopReason(
  finishReason: string | null | undefined,
): string | null {
  switch (finishReason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "refusal";
    case null:
    case undefined:
    case "":
      return null;
    default:
      return "end_turn";
  }
}

/* ------------------------------------------------------------------ */
/* Non-streaming response conversion                                   */
/* ------------------------------------------------------------------ */

interface OpenAIChoice {
  index: number;
  message: {
    role: string;
    content: string | null;
    reasoning_content?: string;
    tool_calls?: OpenAIToolCall[];
    [k: string]: unknown;
  };
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
  [k: string]: unknown;
}

interface AnthropicResponse {
  id: string;
  model: string;
  content: AnthropicBlock[];
  stop_reason: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/** Convert an OpenAI non-streaming response to Anthropic format. */
export function openAIResponseToAnthropic(
  body: OpenAIResponse,
): AnthropicResponse {
  const choice = body.choices?.[0];
  const message = choice?.message;
  const content: AnthropicBlock[] = [];

  const reasoning =
    message &&
    REASONING_FIELDS.map((f) => (message as Record<string, unknown>)[f]).find(
      (v) => typeof v === "string" && (v as string).length > 0,
    );
  if (typeof reasoning === "string") {
    content.push({
      type: "thinking",
      thinking: reasoning,
      signature: "",
    });
  }
  if (typeof message?.content === "string" && message.content.length > 0) {
    content.push({ type: "text", text: message.content });
  }
  if (Array.isArray(message?.tool_calls)) {
    for (const call of message.tool_calls) {
      if (!call) continue;
      content.push({
        type: "tool_use",
        id: call.id ?? "call_proxy",
        name: call.function?.name || "unknown_tool",
        input: safeParseJSON(call.function?.arguments),
      });
    }
  }
  if (content.length === 0) content.push({ type: "text", text: "" });

  return {
    id: body.id,
    model: body.model,
    type: "message",
    role: "assistant",
    content,
    stop_reason: finishReasonToStopReason(choice?.finish_reason),
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
  const reasoningParts: string[] = [];
  const textParts: string[] = [];
  const toolCalls: OpenAIToolCall[] = [];
  let toolIndex = 0;

  for (const block of body.content || []) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    } else if (block.type === "thinking") {
      if (typeof block.thinking === "string" && block.thinking.length > 0) {
        reasoningParts.push(block.thinking);
      }
    } else if (block.type === "redacted_thinking") {
      reasoningParts.push("(redacted thinking)");
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: typeof block.id === "string" ? block.id : `call_proxy_${toolIndex}`,
        type: "function",
        function: {
          name: typeof block.name === "string" ? block.name : "unknown_tool",
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
      toolIndex++;
    }
  }

  const message: OpenAIChoice["message"] = {
    role: "assistant",
    content: textParts.join(""),
  };
  if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join("\n");
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: body.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: stopReasonToFinishReason(body.stop_reason) ?? "stop",
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

interface StreamConvertOptions {
  /** Called when reasoning content is observed in the upstream stream. */
  onThinking?: () => void;
}

/** Parse an SSE text chunk into data payload strings (handles framing). */
function makeSSEParser() {
  const decoder = new TextDecoder();
  let buf = "";
  return {
    /** Feed raw bytes; returns complete `data:` payload strings. */
    feed(value: Uint8Array): string[] {
      buf += decoder.decode(value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop() || "";
      const payloads: string[] = [];
      for (const evt of events) {
        for (const line of evt.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data:")) {
            payloads.push(trimmed.slice(5).trim());
          }
        }
      }
      return payloads;
    },
    /** Flush any trailing buffered event (upstream may omit the last \n\n). */
    flush(): string[] {
      const rest = buf;
      buf = "";
      const trimmed = rest.trim();
      if (!trimmed.startsWith("data:")) return [];
      return [trimmed.slice(5).trim()];
    },
  };
}

/**
 * Convert an OpenAI SSE stream (chat.completion.chunk events) into an
 * Anthropic SSE stream (message_start → blocks → message_delta → message_stop).
 *
 * Emits `thinking` blocks (with thinking_delta) for `delta.reasoning_content`,
 * text blocks for `delta.content`, and tool_use blocks (with input_json_delta)
 * for `delta.tool_calls`. Terminal events are always emitted, on [DONE] or
 * upstream close, so Anthropic clients never see a truncated message.
 */
export function openAIStreamToAnthropicStream(
  upstream: Response,
  model: string,
  options?: StreamConvertOptions,
): Response {
  const parser = makeSSEParser();
  const messageId = `msg_proxy_${Date.now().toString(36)}`;

  let started = false;
  let closed = false;
  let nextIndex = 0;
  let thinkingBlock: number | null = null;
  let textBlock: number | null = null;
  const toolBlocks = new Map<number, number>(); // openai tool index → block index
  let stopReason: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;

  const event = (name: string, data: unknown) =>
    enc.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);

  const closeBlocks = (controller: TransformStreamDefaultController<Uint8Array>) => {
    for (const blockIndex of [thinkingBlock, textBlock, ...toolBlocks.values()]) {
      if (blockIndex !== null) {
        controller.enqueue(event("content_block_stop", {
          type: "content_block_stop",
          index: blockIndex,
        }));
      }
    }
    thinkingBlock = null;
    textBlock = null;
    toolBlocks.clear();
  };

  const finish = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (closed) return;
    closed = true;
    if (!started) {
      // Emit at least an empty text block so the client doesn't hang.
      controller.enqueue(event("message_start", {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }));
      started = true;
    }
    closeBlocks(controller);
    controller.enqueue(event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason ?? "end_turn", stop_sequence: null },
      usage: { output_tokens: outputTokens },
    }));
    controller.enqueue(event("message_stop", { type: "message_stop" }));
  };

  const ensureStart = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (started) return;
    controller.enqueue(event("message_start", {
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
    }));
    started = true;
  };

  /** Process one SSE payload. Returns true when the stream is finished. */
  const handlePayload = (
    controller: TransformStreamDefaultController<Uint8Array>,
    payload: string,
  ): boolean => {
    if (payload === "[DONE]") {
      finish(controller);
      controller.terminate();
      return true;
    }
    let json: {
      choices?: Array<{
        delta?: {
          role?: string;
          content?: string | null;
          reasoning_content?: string;
          reasoning?: string;
          reasoning_text?: string;
          tool_calls?: OpenAIToolCall[];
        };
        finish_reason?: string | null;
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
      };
    };
    try {
      json = JSON.parse(payload);
    } catch {
      return false;
    }

    if (json.usage?.prompt_tokens) inputTokens = json.usage.prompt_tokens;
    if (json.usage?.completion_tokens) outputTokens = json.usage.completion_tokens;

    const choice = json.choices?.[0];
    const delta = choice?.delta;

    if (choice?.finish_reason) {
      stopReason = finishReasonToStopReason(choice.finish_reason);
    }

    const reasoning =
      delta?.reasoning_content ?? delta?.reasoning ?? delta?.reasoning_text;

    if (typeof reasoning === "string" && reasoning.length > 0) {
      ensureStart(controller);
      options?.onThinking?.();
      if (thinkingBlock === null) {
        thinkingBlock = nextIndex++;
        controller.enqueue(event("content_block_start", {
          type: "content_block_start",
          index: thinkingBlock,
          content_block: { type: "thinking", thinking: "" },
        }));
      }
      outputTokens += Math.ceil(reasoning.length / 4);
      controller.enqueue(event("content_block_delta", {
        type: "content_block_delta",
        index: thinkingBlock,
        delta: { type: "thinking_delta", thinking: reasoning },
      }));
    }

    if (typeof delta?.content === "string" && delta.content.length > 0) {
      ensureStart(controller);
      if (textBlock === null) {
        textBlock = nextIndex++;
        controller.enqueue(event("content_block_start", {
          type: "content_block_start",
          index: textBlock,
          content_block: { type: "text", text: "" },
        }));
      }
      outputTokens += Math.ceil(delta.content.length / 4);
      controller.enqueue(event("content_block_delta", {
        type: "content_block_delta",
        index: textBlock,
        delta: { type: "text_delta", text: delta.content },
      }));
    }

    if (Array.isArray(delta?.tool_calls)) {
      ensureStart(controller);
      for (const call of delta.tool_calls) {
        if (!call) continue;
        const toolIndex = call.index ?? 0;
        let blockIndex = toolBlocks.get(toolIndex);
        if (blockIndex === undefined) {
          blockIndex = nextIndex++;
          toolBlocks.set(toolIndex, blockIndex);
          controller.enqueue(event("content_block_start", {
            type: "content_block_start",
            index: blockIndex,
            content_block: {
              type: "tool_use",
              id: call.id ?? `call_proxy_${toolIndex}`,
              name: call.function?.name || "unknown_tool",
              input: {},
            },
          }));
        }
        const args = call.function?.arguments;
        if (typeof args === "string" && args.length > 0) {
          controller.enqueue(event("content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "input_json_delta", partial_json: args },
          }));
        }
      }
    }
    return false;
  };

  // TransformStream (not a pull-based ReadableStream): pull-based streams
  // deadlock when a pull completes without enqueueing anything — exactly
  // what happens while the SSE parser is still accumulating a partial
  // event. TransformStream's transform/flush contract handles backpressure
  // and partial chunks correctly.
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (closed) return;
      for (const payload of parser.feed(chunk)) {
        if (handlePayload(controller, payload)) return;
      }
    },
    flush(controller) {
      if (closed) return;
      for (const payload of parser.flush()) {
        if (handlePayload(controller, payload)) return;
      }
      finish(controller);
    },
  });

  return new Response(
    (upstream.body as ReadableStream<Uint8Array>).pipeThrough(transform),
    {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    },
  );
}

/**
 * Convert an Anthropic SSE stream into an OpenAI SSE stream
 * (chat.completion.chunk events ending with `data: [DONE]`).
 *
 * thinking_delta → delta.reasoning_content, text_delta → delta.content,
 * tool_use blocks → delta.tool_calls (with streamed argument fragments),
 * message_delta → finish_reason + usage. A usage-only chunk is emitted
 * before [DONE] (the shape OpenAI's stream_options.include_usage produces).
 */
export function anthropicStreamToOpenAIStream(
  upstream: Response,
  model: string,
  options?: StreamConvertOptions,
): Response {
  const parser = makeSSEParser();
  const id = `chatcmpl_proxy_${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);

  let started = false;
  const toolBlockToIndex = new Map<number, number>(); // anthropic block index → openai tool index
  let nextToolIndex = 0;
  let finishReason: string | null = null;
  let promptTokens = 0;
  let completionTokens = 0;
  let closed = false;

  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    enc.encode(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`,
    );

  const emitUsage = (controller: TransformStreamDefaultController<Uint8Array>) => {
    controller.enqueue(
      enc.encode(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
        })}\n\n`,
      ),
    );
  };

  const finishStream = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (closed) return;
    closed = true;
    if (!started) {
      controller.enqueue(chunk({ role: "assistant" }));
      started = true;
    }
    controller.enqueue(chunk({}, finishReason ?? "stop"));
    emitUsage(controller);
    controller.enqueue(enc.encode("data: [DONE]\n\n"));
  };

  /** Process one SSE payload. Returns true when the stream is finished. */
  const handlePayload = (
    controller: TransformStreamDefaultController<Uint8Array>,
    payload: string,
  ): boolean => {
    if (!payload || payload === "[DONE]") return false;
    let json: {
      type?: string;
      message?: { usage?: { input_tokens?: number } };
      index?: number;
      content_block?: { type?: string; id?: string; name?: string };
      delta?: {
        type?: string;
        text?: string;
        thinking?: string;
        partial_json?: string;
        stop_reason?: string | null;
      };
      usage?: { input_tokens?: number; output_tokens?: number };
      error?: unknown;
    };
    try {
      json = JSON.parse(payload);
    } catch {
      return false;
    }

        switch (json.type) {
          case "message_start": {
            promptTokens = json.message?.usage?.input_tokens ?? 0;
            if (!started) {
              controller.enqueue(chunk({ role: "assistant" }));
              started = true;
            }
            break;
          }
          case "content_block_start": {
            const idx = json.index ?? 0;
            const kind = json.content_block?.type;
            if (kind === "tool_use") {
              const toolIndex = nextToolIndex++;
              toolBlockToIndex.set(idx, toolIndex);
              if (!started) {
                controller.enqueue(chunk({ role: "assistant" }));
                started = true;
              }
              controller.enqueue(
                chunk({
                  tool_calls: [
                    {
                      index: toolIndex,
                      id: json.content_block?.id ?? `call_proxy_${toolIndex}`,
                      type: "function",
                      function: {
                        name: json.content_block?.name || "unknown_tool",
                        arguments: "",
                      },
                    },
                  ],
                }),
              );
            }
            break;
          }
          case "content_block_delta": {
            const idx = json.index ?? 0;
            const delta = json.delta;
            if (!delta) break;
            if (delta.type === "thinking_delta" && delta.thinking) {
              options?.onThinking?.();
              if (!started) {
                controller.enqueue(chunk({ role: "assistant" }));
                started = true;
              }
              controller.enqueue(chunk({ reasoning_content: delta.thinking }));
            } else if (delta.type === "text_delta" && delta.text) {
              if (!started) {
                controller.enqueue(chunk({ role: "assistant" }));
                started = true;
              }
              controller.enqueue(chunk({ content: delta.text }));
            } else if (delta.type === "input_json_delta" && delta.partial_json) {
              const toolIndex = toolBlockToIndex.get(idx) ?? 0;
              controller.enqueue(
                chunk({
                  tool_calls: [
                    {
                      index: toolIndex,
                      function: { arguments: delta.partial_json },
                    },
                  ],
                }),
              );
            }
            // signature_delta: nothing to carry on the OpenAI wire.
            break;
          }
          case "message_delta": {
            if (json.delta?.stop_reason) {
              finishReason = stopReasonToFinishReason(json.delta.stop_reason);
            }
            if (json.usage?.output_tokens) completionTokens = json.usage.output_tokens;
            break;
          }
          case "message_stop": {
            finishStream(controller);
            controller.terminate();
            return true;
          }
          case "error": {
            controller.enqueue(
              enc.encode(`data: ${JSON.stringify({ error: json.error ?? { message: "upstream stream error" } })}\n\n`),
            );
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
            closed = true;
            controller.terminate();
            return true;
          }
          default:
            // ping, content_block_stop, etc.
            break;
        }
    return false;
  };

  // TransformStream (not a pull-based ReadableStream): pull-based streams
  // deadlock when a pull completes without enqueueing anything — exactly
  // what happens while the SSE parser is still accumulating a partial
  // event. TransformStream's transform/flush contract handles backpressure
  // and partial chunks correctly.
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (closed) return;
      for (const payload of parser.feed(chunk)) {
        if (handlePayload(controller, payload)) return;
      }
    },
    flush(controller) {
      if (closed) return;
      for (const payload of parser.flush()) {
        if (handlePayload(controller, payload)) return;
      }
      finishStream(controller);
    },
  });

  return new Response(
    (upstream.body as ReadableStream<Uint8Array>).pipeThrough(transform),
    {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    },
  );
}

/* ------------------------------------------------------------------ */
/* SSE-framed non-streaming response reconstruction                    */
/* ------------------------------------------------------------------ */

/**
 * Reconstruct a full OpenAI response object from SSE `data:` lines an
 * upstream wrongly returned for a non-streaming request. Merges chunk
 * deltas (content, reasoning, tool_calls) in order; falls back to the
 * first parseable chunk (error payloads).
 */
export function reconstructOpenAIResponseFromSSE(text: string): unknown | null {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter((l) => l && l !== "[DONE]");
  if (lines.length === 0) return null;

  let id = "";
  let model = "";
  let finishReason: string | null = null;
  let content = "";
  let reasoning = "";
  const toolCalls: Record<number, OpenAIToolCall> = {};
  let promptTokens = 0;
  let completionTokens = 0;

  for (const line of lines) {
    try {
      const json = JSON.parse(line) as {
        id?: string;
        model?: string;
        choices?: Array<{
          delta?: Record<string, unknown>;
          finish_reason?: string | null;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        error?: unknown;
      };
      if (json.error) return json; // error payload — return as-is
      if (json.id) id = json.id;
      if (json.model) model = json.model;
      if (json.usage?.prompt_tokens) promptTokens = json.usage.prompt_tokens;
      if (json.usage?.completion_tokens) {
        completionTokens = json.usage.completion_tokens;
      }
      const choice = json.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta as
        | {
            content?: string | null;
            reasoning_content?: string;
            tool_calls?: OpenAIToolCall[];
          }
        | undefined;
      if (typeof delta?.content === "string") content += delta.content;
      if (typeof delta?.reasoning_content === "string") {
        reasoning += delta.reasoning_content;
      }
      if (Array.isArray(delta?.tool_calls)) {
        for (const call of delta.tool_calls) {
          if (!call) continue;
          const idx = call.index ?? 0;
          const existing = toolCalls[idx] ?? {
            id: call.id,
            type: "function",
            function: { name: "", arguments: "" },
          };
          if (call.id) existing.id = call.id;
          if (call.function?.name) existing.function!.name = call.function.name;
          if (call.function?.arguments) {
            existing.function!.arguments =
              (existing.function!.arguments || "") + call.function.arguments;
          }
          toolCalls[idx] = existing;
        }
      }
    } catch {
      continue;
    }
  }

  const message: OpenAIChoice["message"] = { role: "assistant", content };
  if (reasoning) message.reasoning_content = reasoning;
  const calls = Object.values(toolCalls);
  if (calls.length > 0) message.tool_calls = calls;

  return {
    id: id || "chatcmpl_proxy_reconstructed",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason ?? "stop" }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  } satisfies OpenAIResponse;
}

/**
 * Reconstruct a full Anthropic response object from SSE `data:` lines an
 * upstream wrongly returned for a non-streaming request.
 */
export function reconstructAnthropicResponseFromSSE(text: string): unknown | null {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter((l) => l && l !== "[DONE]");
  if (lines.length === 0) return null;

  let id = "msg_proxy_reconstructed";
  let model = "";
  let stopReason: string | null = null;
  const blocks: AnthropicBlock[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  const blockState = new Map<number, AnthropicBlock>();

  for (const line of lines) {
    try {
      const json = JSON.parse(line) as {
        type?: string;
        message?: { id?: string; model?: string; usage?: { input_tokens?: number } };
        index?: number;
        content_block?: Record<string, unknown>;
        delta?: {
          type?: string;
          text?: string;
          thinking?: string;
          partial_json?: string;
          stop_reason?: string | null;
        };
        usage?: { output_tokens?: number };
        error?: unknown;
      };
      if (json.error) return json;
      switch (json.type) {
        case "message_start": {
          id = json.message?.id ?? id;
          model = json.message?.model ?? model;
          inputTokens = json.message?.usage?.input_tokens ?? 0;
          break;
        }
        case "content_block_start": {
          const idx = json.index ?? blocks.length;
          const block = (json.content_block ?? { type: "text", text: "" }) as AnthropicBlock;
          if (block.type === "tool_use") {
            block.input = {};
          }
          blockState.set(idx, block);
          blocks.push(block);
          break;
        }
        case "content_block_delta": {
          const idx = json.index ?? 0;
          const block = blockState.get(idx);
          if (!block) break;
          if (json.delta?.type === "text_delta" && typeof json.delta.text === "string") {
            block.text = String(block.text ?? "") + json.delta.text;
          } else if (json.delta?.type === "thinking_delta" && typeof json.delta.thinking === "string") {
            block.thinking = String(block.thinking ?? "") + json.delta.thinking;
          } else if (json.delta?.type === "input_json_delta" && json.delta.partial_json) {
            const current = typeof block.input_json === "string" ? block.input_json : "";
            block.input_json = current + json.delta.partial_json;
          }
          break;
        }
        case "message_delta": {
          if (json.delta?.stop_reason) stopReason = json.delta.stop_reason;
          if (json.usage?.output_tokens) outputTokens = json.usage.output_tokens;
          break;
        }
        default:
          break;
      }
    } catch {
      continue;
    }
  }

  for (const block of blocks) {
    if (block.type === "tool_use") {
      try {
        block.input = JSON.parse(String(block.input_json ?? "{}"));
      } catch {
        block.input = {};
      }
      delete block.input_json;
    }
  }

  return {
    id,
    model,
    type: "message",
    role: "assistant",
    content: blocks.length > 0 ? blocks : [{ type: "text", text: "" }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

/* ------------------------------------------------------------------ */
/* Top-level dispatcher                                                 */
/* ------------------------------------------------------------------ */

/**
 * The conversion label. NOTE: ASCII `->` only — this string rides the
 * `X-Pi-Proxy-Conversion` response header, and Node's Headers rejects
 * non-ASCII header values (the `→` form crashed every converted response
 * with `TypeError: Header ... has invalid value`).
 */
export type Conversion = "none" | "openai->anthropic" | "anthropic->openai";

/**
 * Decide whether conversion is needed between the client's request
 * format and the upstream provider's wire format.
 */
export function conversionNeeded(
  clientFormat: WireFormat,
  providerFormat: WireFormat,
): Conversion {
  if (clientFormat === providerFormat) return "none";
  return clientFormat === "openai" ? "openai->anthropic" : "anthropic->openai";
}

/**
 * Convert a request body from the client's format to the provider's format.
 */
export function convertRequestBody(
  body: unknown,
  conversion: Conversion,
): unknown {
  if (conversion === "none") return body;
  if (conversion === "openai->anthropic") {
    return openAIRequestToAnthropic(body as OpenAIRequestBody);
  }
  return anthropicRequestToOpenAI(body as AnthropicRequestBody);
}

/**
 * Convert a non-streaming upstream response back to the client's format.
 *
 * NOTE the direction: `conversion` names the REQUEST direction
 * (client -> provider). The RESPONSE travels the opposite way, so
 * `openai->anthropic` (an OpenAI client behind an Anthropic provider)
 * converts the provider's ANTHROPIC body back to OpenAI — the v2.1.0
 * dispatch had this inverted and returned an empty Anthropic shell to
 * OpenAI clients.
 */
export function convertResponseBody(
  body: unknown,
  conversion: Conversion,
): unknown {
  if (conversion === "none") return body;
  if (conversion === "openai->anthropic") {
    // OpenAI client, Anthropic provider: anthropic body -> openai shape.
    return anthropicResponseToOpenAI(body as AnthropicResponse);
  }
  // Anthropic client, OpenAI provider: openai body -> anthropic shape.
  return openAIResponseToAnthropic(body as OpenAIResponse);
}

/**
 * Wrap an upstream streaming response, converting its SSE format back to
 * the client's expected format. For `conversion === "none"`, the response
 * is returned unchanged (byte-for-byte passthrough).
 *
 * NOTE the direction: `conversion` names the REQUEST direction
 * (client -> provider); the upstream stream travels the opposite way,
 * so `openai->anthropic` (OpenAI client, Anthropic provider) converts
 * the provider's ANTHROPIC SSE back to OpenAI chunk shape.
 */
export function convertStreamResponse(
  upstream: Response,
  conversion: Conversion,
  model: string,
  options?: StreamConvertOptions,
): Response {
  if (conversion === "none") return upstream;
  if (conversion === "openai->anthropic") {
    // OpenAI client, Anthropic provider: anthropic SSE -> openai chunks.
    return anthropicStreamToOpenAIStream(upstream, model, options);
  }
  // Anthropic client, OpenAI provider: openai SSE -> anthropic events.
  return openAIStreamToAnthropicStream(upstream, model, options);
}
