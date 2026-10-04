/**
 * Thinking-mode helpers: reasoning dialect detection, replay padding, and
 * a learned registry of models whose upstreams produce reasoning.
 *
 * WHY THIS EXISTS
 *
 * Strict thinking-mode channels (observed live: a GLM-family upstream behind
 * the AgentRouter relay, error text "The content[].thinking in the thinking
 * mode must be passed back to the API") reject a request whose assistant
 * history carries reasoning on some turns but not others. The thinking-less
 * turns come from the same relay's lenient channels or from non-reasoning
 * fallback models, so the conversation is thinking-mode by any reading, and
 * one bare turn poisons every later request until the relay rotates back to
 * a lenient channel.
 *
 * A client can only fix this for the wire shape it controls (an
 * OpenAI-completions client can pad `reasoning_content`, but NOT emit
 * Anthropic `content[].thinking` blocks — the relay's OpenAI ingress
 * rejects them with "unknown variant `thinking`"). The proxy sits at the
 * boundary between the two wire formats, so it is the only component that
 * can guarantee every replayed assistant turn carries reasoning in the
 * shape the upstream actually wants:
 *
 *   - OpenAI-format upstreams   → pad the message-level reasoning field
 *     (`reasoning_content` / `reasoning` / `reasoning_text` — whichever
 *     dialect the conversation already speaks, empty string when none does,
 *     matching what a thinking-mode upstream itself returns for a turn
 *     that produced no reasoning).
 *   - Anthropic-format upstreams → prepend a `thinking` content block to
 *     assistant turns that lack one (with a minimal placeholder, since a
 *     bare turn has no reasoning text to replay).
 *
 * The gate mirrors LEGION's client-side pad (self-limiting by construction):
 *
 *   - "auto" (default): pad only when the conversation already speaks a
 *     reasoning dialect (some assistant turn carries reasoning), or when
 *     the model is known to produce reasoning (learned from observed
 *     responses, or declared in models.json).
 *   - "always": pad every request unconditionally.
 *   - "never": never pad.
 *
 * @module lib/thinking
 */

/** The reasoning field spellings an OpenAI-completions payload may speak. */
export const REASONING_FIELDS = [
  "reasoning_content",
  "reasoning",
  "reasoning_text",
] as const;

export type ReasoningField = (typeof REASONING_FIELDS)[number];

/** Padding mode for thinking replay. */
export type ThinkingPadMode = "auto" | "always" | "never";

/**
 * Placeholder text for padded Anthropic thinking blocks. Empty string is not
 * used here because a content block should carry *some* text; a single dot
 * is minimal and inert. Tunable via PI_THINKING_PLACEHOLDER.
 */
export const THINKING_PLACEHOLDER =
  process.env.PI_THINKING_PLACEHOLDER !== undefined
    ? process.env.PI_THINKING_PLACEHOLDER
    : ".";

/** Global pad-mode override (wins over models.json). */
export const GLOBAL_PAD_MODE: ThinkingPadMode | null = (() => {
  const v = process.env.PI_THINKING_PADDING;
  if (v === "always" || v === "auto" || v === "never") return v;
  return null;
})();

/* ------------------------------------------------------------------ */
/* Wire-shape helpers                                                  */
/* ------------------------------------------------------------------ */

interface WireMessage {
  role?: unknown;
  content?: unknown;
  [field: string]: unknown;
}

interface WirePayload {
  messages?: unknown;
  [field: string]: unknown;
}

function asMessageArray(body: unknown): WireMessage[] | null {
  if (typeof body !== "object" || body === null) return null;
  const messages = (body as WirePayload).messages;
  if (!Array.isArray(messages)) return null;
  return messages as WireMessage[];
}

function isAssistant(message: WireMessage): boolean {
  return message.role === "assistant";
}

/** The reasoning field some assistant turn of this payload already speaks. */
export function spokenReasoningDialect(body: unknown): ReasoningField | undefined {
  const messages = asMessageArray(body);
  if (!messages) return undefined;
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    if (!isAssistant(message as WireMessage)) continue;
    for (const field of REASONING_FIELDS) {
      const value = (message as WireMessage)[field];
      if (typeof value === "string" && value.length > 0) return field;
    }
  }
  return undefined;
}

/** True when some assistant turn already carries an Anthropic thinking block. */
export function anthropicBodySpeaksThinking(body: unknown): boolean {
  const messages = asMessageArray(body);
  if (!messages) return false;
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const candidate = message as WireMessage;
    if (!isAssistant(candidate)) continue;
    if (Array.isArray(candidate.content)) {
      for (const block of candidate.content) {
        if (
          block &&
          typeof block === "object" &&
          ((block as { type?: string }).type === "thinking" ||
            (block as { type?: string }).type === "redacted_thinking")
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* OpenAI-shape padding                                                */
/* ------------------------------------------------------------------ */

export interface PadResult {
  body: unknown;
  /** Number of assistant messages that gained a reasoning field/block. */
  padded: number;
  /** Which gate fired. */
  mode: "dialect" | "forced" | "off";
}

/**
 * Pad thinking-less assistant turns on an OpenAI-completions body with the
 * conversation's reasoning dialect (empty string — the shape a thinking-mode
 * upstream itself returns for a turn that produced no reasoning).
 *
 * - Only assistant messages missing the dialect field are touched.
 * - When `force` is set and no dialect is spoken, `reasoning_content` is used.
 * - A body that neither speaks a dialect nor is forced passes through
 *   byte-identically (same object reference).
 */
export function padOpenAIReasoning(body: unknown, force: boolean): PadResult {
  const dialect = spokenReasoningDialect(body);
  if (!dialect && !force) return { body, padded: 0, mode: "off" };
  const field: ReasoningField = dialect ?? "reasoning_content";

  const messages = asMessageArray(body);
  if (!messages) return { body, padded: 0, mode: "off" };

  const needsPad = messages.some(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      isAssistant(message) &&
      typeof message[field] !== "string",
  );
  if (!needsPad) return { body, padded: 0, mode: dialect ? "dialect" : "forced" };

  let padded = 0;
  const newMessages = messages.map((message) => {
    if (typeof message !== "object" || message === null) return message;
    if (!isAssistant(message) || typeof message[field] === "string") return message;
    padded += 1;
    return { ...message, [field]: "" };
  });

  return {
    body: { ...(body as WirePayload), messages: newMessages },
    padded,
    mode: dialect ? "dialect" : "forced",
  };
}

/* ------------------------------------------------------------------ */
/* Anthropic-shape padding                                             */
/* ------------------------------------------------------------------ */

interface AnthropicBlock {
  type?: string;
  [k: string]: unknown;
}

function leadingThinkingBlock(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  const first = content[0] as AnthropicBlock | undefined;
  return (
    !!first &&
    typeof first === "object" &&
    (first.type === "thinking" || first.type === "redacted_thinking")
  );
}

/**
 * Prepend a minimal thinking block to assistant turns that lack one on an
 * Anthropic Messages body. Strict thinking-mode channels (z.ai-style
 * `content[].thinking`) require every replayed assistant turn to open with
 * its reasoning.
 *
 * - Gate: the conversation already has a thinking block on some assistant
 *   turn, or `force` is set.
 * - Assistant turns whose content is a string become
 *   `[{thinking}, {text}]`; array content gets the block prepended.
 * - Turns that already open with thinking/redacted_thinking pass untouched.
 */
export function padAnthropicThinking(body: unknown, force: boolean): PadResult {
  const speaks = anthropicBodySpeaksThinking(body);
  if (!speaks && !force) return { body, padded: 0, mode: "off" };

  const messages = asMessageArray(body);
  if (!messages) return { body, padded: 0, mode: "off" };

  const needsPad = messages.some(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      isAssistant(message) &&
      !leadingThinkingBlock((message as WireMessage).content),
  );
  if (!needsPad) return { body, padded: 0, mode: speaks ? "dialect" : "forced" };

  let padded = 0;
  const newMessages = messages.map((message) => {
    if (typeof message !== "object" || message === null) return message;
    const candidate = message as WireMessage;
    if (!isAssistant(candidate) || leadingThinkingBlock(candidate.content)) {
      return message;
    }
    padded += 1;
    const thinkingBlock: AnthropicBlock = {
      type: "thinking",
      thinking: THINKING_PLACEHOLDER,
    };
    if (typeof candidate.content === "string") {
      const blocks: AnthropicBlock[] = [thinkingBlock];
      if (candidate.content.length > 0) {
        blocks.push({ type: "text", text: candidate.content });
      }
      return { ...candidate, content: blocks };
    }
    if (Array.isArray(candidate.content)) {
      return { ...candidate, content: [thinkingBlock, ...candidate.content] };
    }
    return { ...candidate, content: [thinkingBlock] };
  });

  return {
    body: { ...(body as WirePayload), messages: newMessages },
    padded,
    mode: speaks ? "dialect" : "forced",
  };
}

/* ------------------------------------------------------------------ */
/* Learned thinking-model registry                                     */
/* ------------------------------------------------------------------ */

/**
 * Models whose observed responses carried reasoning content, keyed by
 * `<provider>::<model>`. In-memory only: a restart forgets, and the first
 * request after a restart re-learns from the response. This registry lets
 * the proxy pad requests for thinking models even when the client's
 * history carries no reasoning dialect at all (fresh conversations, or
 * history produced while an older proxy stripped reasoning).
 */
const thinkingModels = new Map<string, true>();

function key(providerName: string, model: string): string {
  return `${providerName}::${model}`;
}

/** Record that a provider+model combination produced reasoning content. */
export function markModelProducesThinking(providerName: string, model: string): void {
  if (!providerName || !model) return;
  thinkingModels.set(key(providerName, model), true);
}

/** Whether a provider+model combination is known to produce reasoning. */
export function modelProducesThinking(providerName: string, model: string): boolean {
  return thinkingModels.has(key(providerName, model));
}

/** Snapshot of the learned registry (for /api/debug observability). */
export function thinkingModelRegistrySnapshot(): string[] {
  return Array.from(thinkingModels.keys()).sort();
}

/* ------------------------------------------------------------------ */
/* Response observation                                                */
/* ------------------------------------------------------------------ */

/**
 * Detect reasoning content in a parsed *upstream-format* response body and
 * mark the provider+model as thinking-producing. Cheap substring-free
 * structural checks only.
 */
export function observeThinkingInResponse(
  parsed: unknown,
  providerFormat: "openai" | "anthropic",
  providerName: string,
  model: string,
): void {
  try {
    if (providerFormat === "openai") {
      const choices = (parsed as { choices?: unknown })?.choices;
      if (!Array.isArray(choices)) return;
      for (const choice of choices) {
        const message = (choice as { message?: WireMessage })?.message;
        if (!message || typeof message !== "object") continue;
        for (const field of REASONING_FIELDS) {
          const value = message[field];
          if (typeof value === "string" && value.length > 0) {
            markModelProducesThinking(providerName, model);
            return;
          }
        }
      }
    } else {
      const content = (parsed as { content?: unknown })?.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        const type = (block as AnthropicBlock | undefined)?.type;
        if (type === "thinking" || type === "redacted_thinking") {
          markModelProducesThinking(providerName, model);
          return;
        }
      }
    }
  } catch {
    // Observation must never break forwarding.
  }
}
