/**
 * Test: format converter + thinking padding (offline, no network).
 *
 * Covers the v2.1 converter rewrite:
 *   - thinking/reasoning in both directions (request + response + streaming)
 *   - tool calling end-to-end (tools, tool_calls ↔ tool_use, tool_result)
 *   - images (data URLs ↔ base64 sources)
 *   - reasoning_effort → thinking param mapping
 *   - thinking-replay padding (OpenAI dialect + Anthropic block shapes)
 *   - thinking-model learning from responses
 *   - finish-reason / stop-reason mapping
 *   - SSE chunk-boundary robustness (payloads split across reads)
 *   - reconstruction of SSE-framed non-streaming responses
 *
 * Run: bun scripts/test-format-converter.ts
 */

import {
  convertRequestBody,
  convertResponseBody,
  convertStreamResponse,
  anthropicRequestToOpenAI,
  anthropicResponseToOpenAI,
  anthropicStreamToOpenAIStream,
  finishReasonToStopReason,
  openAIRequestToAnthropic,
  openAIResponseToAnthropic,
  openAIStreamToAnthropicStream,
  reconstructOpenAIResponseFromSSE,
  stopReasonToFinishReason,
} from "../src/lib/format-converter";
import {
  markModelProducesThinking,
  modelProducesThinking,
  observeThinkingInResponse,
  padAnthropicThinking,
  padOpenAIReasoning,
  spokenReasoningDialect,
} from "../src/lib/thinking";

let passed = 0;
let failed = 0;

function assert(cond: boolean, label: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

function section(name: string) {
  console.log(`\n=== ${name} ===`);
}

/* ------------------------------------------------------------------ */

section("openAIRequestToAnthropic: reasoning + tools + tool results");

{
  const converted = openAIRequestToAnthropic({
    model: "glm-5.3",
    messages: [
      { role: "system", content: "You are a pentest agent." },
      { role: "user", content: "Scan the target." },
      {
        role: "assistant",
        content: "I'll start the scan.",
        reasoning_content: "Planning the recon workflow first.",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "nmap", arguments: '{"target":"10.0.0.1"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "22/tcp open ssh" },
      { role: "user", content: "Now brute force." },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "nmap",
          description: "Port scanner",
          parameters: { type: "object", properties: { target: { type: "string" } } },
        },
      },
    ],
    tool_choice: "auto",
    max_tokens: 4096,
  } as never);

  const messages = converted.messages as Array<{ role: string; content: unknown }>;
  assert(converted.system === "You are a pentest agent.", "system message → system field");
  assert(messages.length === 3, `3 messages after grouping (got ${messages.length})`);

  const assistant = messages[1];
  const blocks = assistant.content as Array<{ type: string; [k: string]: unknown }>;
  assert(blocks[0]?.type === "thinking", "assistant opens with a thinking block");
  assert(blocks[0]?.thinking === "Planning the recon workflow first.", "thinking text carried");
  assert(blocks[1]?.type === "text", "assistant text block follows");
  assert(blocks[2]?.type === "tool_use", "tool_calls → tool_use block");
  assert(blocks[2]?.id === "call_1", "tool_use id carried");
  assert((blocks[2]?.input as { target: string })?.target === "10.0.0.1", "arguments JSON parsed into input");

  const toolResultMsg = messages[2];
  assert(toolResultMsg.role === "user", "tool result merges into the following user turn");
  const trBlocks = toolResultMsg.content as Array<{ type: string; [k: string]: unknown }>;
  assert(trBlocks[0]?.type === "tool_result", "tool_result block present");
  assert(trBlocks[0]?.tool_use_id === "call_1", "tool_use_id carried");
  assert(converted.max_tokens === 4096, "max_tokens carried");
  const tools = converted.tools as Array<{ name: string; input_schema: unknown }>;
  assert(tools?.[0]?.name === "nmap", "tools converted to anthropic shape");
  assert(tools?.[0]?.input_schema !== undefined, "parameters → input_schema");
  assert(
    JSON.stringify(converted.tool_choice) === '{"type":"auto"}',
    "tool_choice auto → {type:auto}",
  );

  const lastUser = messages[2];
  const lastBlocks = lastUser.content as Array<{ type: string }>;
  assert(lastBlocks?.[1]?.type === "text", "trailing user text preserved after tool_result");
}

section("openAIRequestToAnthropic: reasoning_effort → thinking param");

{
  const withEffort = openAIRequestToAnthropic({
    model: "x",
    messages: [{ role: "user", content: "hi" }],
    reasoning_effort: "high",
    max_tokens: 32768,
  } as never);
  const thinking = withEffort.thinking as { type: string; budget_tokens: number };
  assert(thinking?.type === "enabled", "thinking enabled for reasoning_effort");
  assert(thinking?.budget_tokens === 16384, "high effort → 16384 budget");

  const withoutEffort = openAIRequestToAnthropic({
    model: "x",
    messages: [{ role: "user", content: "hi" }],
  } as never);
  assert(withoutEffort.thinking === undefined, "no reasoning_effort → no thinking param");
  assert(withoutEffort.max_tokens === 8192, "max_tokens defaults to 8192");
}

section("openAIRequestToAnthropic: images (data URL → base64 source)");

{
  const converted = openAIRequestToAnthropic({
    model: "x",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
          { type: "image_url", image_url: { url: "https://example.com/a.png" } },
        ],
      },
    ],
  } as never);
  const blocks = (converted.messages[0] as { content: Array<{ type: string; source?: { type: string; [k: string]: unknown } }> }).content;
  assert(blocks[0]?.type === "text", "text part kept");
  assert(
    blocks[1]?.source?.type === "base64" && blocks[1]?.source?.media_type === "image/png",
    "data URL → base64 source",
  );
  assert(blocks[2]?.source?.type === "url", "http URL → url source");
}

section("padOpenAIReasoning: dialect-driven + forced");

{
  const body = {
    model: "x",
    messages: [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1", reasoning_content: "thinking about q1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2 (came from a lenient channel)" },
    ],
  };
  const res = padOpenAIReasoning(body, false);
  assert(res.mode === "dialect", "dialect gate fires");
  assert(res.padded === 1, "one turn padded");
  const msgs = (res.body as typeof body).messages;
  assert(msgs[3].reasoning_content === "", "padded turn gains empty reasoning_content");
  assert(msgs[1].reasoning_content === "thinking about q1", "real reasoning untouched");

  const dialectless = {
    model: "x",
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ],
  };
  const off = padOpenAIReasoning(dialectless, false);
  assert(off.mode === "off" && off.body === dialectless, "no dialect + no force → untouched");
  const forced = padOpenAIReasoning(dialectless, true);
  assert(forced.mode === "forced" && forced.padded === 1, "forced pads dialect-less history");

  // matches LEGION's dialect spellings
  assert(
    spokenReasoningDialect({ messages: [{ role: "assistant", reasoning: "x" }] }) === "reasoning",
    "llama.cpp `reasoning` dialect detected",
  );
}

section("padAnthropicThinking: block-shape padding for strict channels");

{
  const body = {
    model: "x",
    messages: [
      { role: "user", content: "q1" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "real reasoning" },
          { type: "text", text: "a1" },
        ],
      },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2 without thinking" },
    ],
  };
  const res = padAnthropicThinking(body, false);
  assert(res.mode === "dialect", "thinking-dialect gate fires");
  assert(res.padded === 1, "one turn padded");
  const padded = ((res.body as typeof body).messages[3] as { content: Array<{ type: string }> }).content;
  assert(Array.isArray(padded) && padded[0]?.type === "thinking", "string content → thinking block prepended");
  assert(padded[1]?.type === "text", "original text preserved as text block");
  assert(
    ((res.body as typeof body).messages[3] as { content: Array<{ thinking: string }> }).content[0].thinking.length > 0,
    "placeholder thinking text is non-empty",
  );

  const clean = { model: "x", messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }] };
  assert(padAnthropicThinking(clean, false).mode === "off", "no thinking evidence + no force → untouched");
  assert(padAnthropicThinking(clean, true).padded === 1, "forced pads clean history");
}

section("anthropicRequestToOpenAI: thinking + tool_result + tool_use");

{
  const converted = anthropicRequestToOpenAI({
    model: "claude-opus-5",
    system: "sys",
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "planning" },
          { type: "tool_use", id: "tu_1", name: "nmap", input: { target: "h" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "done" },
          { type: "text", text: "next step" },
        ],
      },
    ],
  } as never);

  const messages = converted.messages as Array<{ role: string; [k: string]: unknown }>;
  assert(messages[0]?.role === "system" && messages[0]?.content === "sys", "system → system message");
  const assistant = messages[2] as { reasoning_content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
  assert(assistant.reasoning_content === "planning", "thinking → reasoning_content");
  assert(assistant.tool_calls?.[0]?.id === "tu_1", "tool_use → tool_calls id");
  assert(assistant.tool_calls?.[0]?.function?.name === "nmap", "tool_use name");
  assert(assistant.tool_calls?.[0]?.function?.arguments === '{"target":"h"}', "input serialized to arguments");
  assert(messages[3]?.role === "tool" && messages[3]?.tool_call_id === "tu_1", "tool_result → role:tool");
  assert(messages[4]?.role === "user" && messages[4]?.content === "next step", "remaining text → user message");
}

section("Non-streaming response: anthropic → openai");

{
  const converted = anthropicResponseToOpenAI({
    id: "msg_1",
    model: "glm-5.3",
    content: [
      { type: "thinking", thinking: "step by step" },
      { type: "text", text: "The answer is 42." },
      { type: "tool_use", id: "tu_9", name: "calc", input: { expr: "6*7" } },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 20 },
  } as never);

  const choice = (converted as { choices: Array<{ message: Record<string, unknown>; finish_reason: string }> }).choices[0];
  assert(choice.message.reasoning_content === "step by step", "thinking → reasoning_content");
  assert(choice.message.content === "The answer is 42.", "text → content");
  assert(
    JSON.stringify(choice.message.tool_calls).includes('"calc"'),
    "tool_use → tool_calls",
  );
  assert(choice.finish_reason === "tool_calls", "stop_reason tool_use → finish_reason tool_calls");
  const usage = (converted as { usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }).usage;
  assert(usage.prompt_tokens === 10 && usage.completion_tokens === 20 && usage.total_tokens === 30, "usage mapped");
}

section("Non-streaming response: openai → anthropic");

{
  const converted = openAIResponseToAnthropic({
    id: "cmpl_1",
    model: "glm-5.3",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "hello",
          reasoning_content: "reasoning here",
          tool_calls: [{ id: "c1", function: { name: "t", arguments: "{}" } }],
        },
        finish_reason: "length",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2 },
  } as never);

  const blocks = (converted as { content: Array<{ type: string; [k: string]: unknown }> }).content;
  assert(blocks[0]?.type === "thinking", "reasoning_content → thinking block");
  assert(blocks[1]?.type === "text", "content → text block");
  assert(blocks[2]?.type === "tool_use", "tool_calls → tool_use");
  assert((converted as { stop_reason: string }).stop_reason === "max_tokens", "length → max_tokens");
}

section("Streaming: anthropic SSE → openai chunks");

{
  const events = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":11}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"answer"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tu_2","name":"nmap","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"t\\":"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\\"h\\"}"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":2}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join("");

  // Feed the stream split across arbitrary chunk boundaries to prove the
  // SSE parser reassembles events correctly.
  const encoder = new TextEncoder();
  const bytes = encoder.encode(events);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += 7) {
    chunks.push(bytes.slice(i, i + 7));
  }
  const upstream = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );

  let observed = false;
  const converted = anthropicStreamToOpenAIStream(upstream, "glm-5.3", {
    onThinking: () => { observed = true; },
  });
  const out = await converted.text();
  const payloads = out
    .split("\n\n")
    .map((l) => l.replace(/^data:\s*/, ""))
    .filter((l) => l && !l.startsWith("event:"));

  let reasoning = "";
  let content = "";
  let toolName = "";
  let toolArgs = "";
  let finish: string | null = null;
  let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
  for (const p of payloads) {
    if (p === "[DONE]") continue;
    try {
      const j = JSON.parse(p) as {
        choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      if (j.usage && (!j.choices || j.choices.length === 0)) usage = j.usage;
      const delta = j.choices?.[0]?.delta as
        | { content?: string; reasoning_content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> }
        | undefined;
      if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
      if (typeof delta?.reasoning_content === "string") reasoning += delta.reasoning_content;
      if (typeof delta?.content === "string") content += delta.content;
      if (delta?.tool_calls?.[0]?.function?.name) toolName = delta.tool_calls[0].function.name;
      if (delta?.tool_calls?.[0]?.function?.arguments) toolArgs += delta.tool_calls[0].function.arguments;
    } catch {
      /* ignore */
    }
  }

  assert(observed, "onThinking callback fired");
  assert(reasoning === "hmm", `thinking_delta → reasoning_content (got "${reasoning}")`);
  assert(content === "answer", `text_delta → content (got "${content}")`);
  assert(toolName === "nmap", "tool_use name streamed");
  assert(toolArgs === '{"t":"h"}', `input_json_delta fragments reassembled (got "${toolArgs}")`);
  assert(finish === "tool_calls", "stop_reason → finish_reason in final chunk");
  assert(usage?.prompt_tokens === 11 && usage?.completion_tokens === 7, "usage chunk emitted before [DONE]");
  assert(out.trimEnd().endsWith("data: [DONE]"), "stream ends with [DONE]");
}

section("Streaming: openai chunks → anthropic SSE");

{
  const chunks = [
    { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { reasoning_content: "pondering" }, finish_reason: null }] },
    { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "hi there" }, finish_reason: null }] },
    { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_9", type: "function", function: { name: "scan", arguments: "" } }] }, finish_reason: null }] },
    { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] }, finish_reason: null }] },
    { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 6 } },
  ]
    .map((c) => `data: ${JSON.stringify(c)}\n\n`)
    .join("") + "data: [DONE]\n\n";

  const upstream = new Response(chunks, { headers: { "Content-Type": "text/event-stream" } });
  const converted = openAIStreamToAnthropicStream(upstream, "glm-5.3");
  const out = await converted.text();
  const events = out.split("\n\n").filter(Boolean);

  const names = events.map((e) => e.split("\n")[0].replace(/^event:\s*/, ""));
  assert(names[0] === "message_start", "first event is message_start");
  assert(names.includes("content_block_start"), "content blocks started");
  const thinkingStart = events.find((e) => e.includes('"thinking"') && e.includes("content_block_start"));
  assert(!!thinkingStart, "thinking block started");
  assert(out.includes('"thinking_delta"') && out.includes("pondering"), "reasoning → thinking_delta");
  assert(out.includes('"text_delta"') && out.includes("hi there"), "content → text_delta");
  assert(out.includes('"tool_use"'), "tool_use block started");
  let streamedArgs = "";
  for (const e of events) {
    const m = /"partial_json":"((?:[^"\\]|\\.)*)"/.exec(e);
    if (m) streamedArgs += JSON.parse(`"${m[1]}"`);
  }
  assert(
    out.includes('"input_json_delta"') && streamedArgs === '{"a":1}',
    `arguments → input_json_delta (assembled "${streamedArgs}")`,
  );
  const stopCount = names.filter((n) => n === "content_block_stop").length;
  assert(stopCount === 3, `all 3 blocks closed (got ${stopCount})`);
  assert(names[names.length - 1] === "message_stop", "last event is message_stop");
  assert(out.includes('"stop_reason":"tool_use"'), "finish_reason → stop_reason in message_delta");
  assert(out.includes('"output_tokens"'), "usage in message_delta");
}

section("Reconstruction: SSE-framed non-stream response");

{
  const sseText = [
    'data: {"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
    'data: {"id":"c1","model":"m","choices":[{"index":0,"delta":{"reasoning_content":"think "},"finish_reason":null}]}\n\n',
    'data: {"id":"c1","model":"m","choices":[{"index":0,"delta":{"content":"Hello "},"finish_reason":null}]}\n\n',
    'data: {"id":"c1","model":"m","choices":[{"index":0,"delta":{"content":"world"},"finish_reason":null}]}\n\n',
    'data: {"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":4}}\n\n',
    "data: [DONE]\n\n",
  ].join("");

  const reconstructed = reconstructOpenAIResponseFromSSE(sseText) as {
    choices: Array<{ message: { content: string; reasoning_content?: string }; finish_reason: string }>;
    usage: { prompt_tokens: number; completion_tokens: number };
  };
  assert(reconstructed.choices[0].message.content === "Hello world", "content merged across chunks");
  assert(reconstructed.choices[0].message.reasoning_content === "think ", "reasoning merged across chunks");
  assert(reconstructed.choices[0].finish_reason === "stop", "finish_reason captured");
  assert(reconstructed.usage.prompt_tokens === 3, "usage captured");
}

section("Thinking-model learning");

{
  observeThinkingInResponse(
    { choices: [{ message: { role: "assistant", content: "x", reasoning_content: "real reasoning" } }] },
    "openai",
    "AgentRouter-Pi",
    "glm-5.3",
  );
  assert(modelProducesThinking("AgentRouter-Pi", "glm-5.3"), "openai response marks model as thinking");

  observeThinkingInResponse(
    { content: [{ type: "thinking", thinking: "y" }] },
    "anthropic",
    "AgentRouter-Pi",
    "glm-5.3",
  );
  assert(modelProducesThinking("AgentRouter-Pi", "glm-5.3"), "anthropic response marks model as thinking");

  markModelProducesThinking("P", "m");
  assert(modelProducesThinking("P", "m") && !modelProducesThinking("P", "other"), "registry keyed by provider+model");
}

section("Dispatcher direction (request vs response travel opposite ways)");

{
  // conversion names the REQUEST direction (client -> provider).
  // openai->anthropic = OpenAI client behind an Anthropic provider:
  // the REQUEST body (client's) converts openai -> anthropic ...
  const req = convertRequestBody(
    { model: "m", messages: [{ role: "user", content: "hi" }] },
    "openai->anthropic",
  ) as {
    messages?: Array<{ role?: string; content?: unknown }>;
  };
  assert(
    Array.isArray(req.messages) &&
      req.messages[0]?.role === "user" &&
      Array.isArray(req.messages[0]?.content) === true,
    "request converted to anthropic shape (block-array content)",
  );
  // ... and the RESPONSE body (provider's) converts anthropic -> openai.
  const anthropicBody = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "pong" },
    ],
    stop_reason: "end_turn",
    usage: { input_tokens: 3, output_tokens: 2 },
  };
  const back = convertResponseBody(anthropicBody, "openai->anthropic") as {
    object?: string;
    choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
  };
  assert(back.object === "chat.completion", "response returned to openai shape (object)");
  assert(
    back.choices?.[0]?.message?.content === "pong",
    "response text survives anthropic->openai return trip",
  );
  assert(
    back.choices?.[0]?.message?.reasoning_content === "hmm",
    "thinking block returned as reasoning_content",
  );
}

{
  // anthropic->openai = Anthropic client behind an OpenAI provider:
  // the provider's OPENAI response must come back in ANTHROPIC shape.
  const openaiBody = {
    id: "chatcmpl-1",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "pong", reasoning_content: "hmm" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  };
  const back = convertResponseBody(openaiBody, "anthropic->openai") as {
    type?: string;
    content?: Array<{ type: string }>;
  };
  assert(back.type === "message", "response returned to anthropic shape (type)");
  assert(
    back.content?.some((b) => b.type === "text") === true &&
      back.content?.some((b) => b.type === "thinking") === true,
    "text + thinking blocks present in anthropic return",
  );
}

{
  // Stream dispatcher: openai->anthropic must convert ANTHROPIC SSE into
  // OPENAI chunks (readable by an OpenAI client).
  const encoder = new TextEncoder();
  const events = [
    "event: message_start\ndata: " +
      JSON.stringify({
        type: "message_start",
        message: { id: "msg_9", model: "m" },
      }) +
      "\n\n",
    "event: content_block_delta\ndata: " +
      JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "hi" },
      }) +
      "\n\n",
    "event: message_stop\ndata: " + JSON.stringify({ type: "message_stop" }) + "\n\n",
  ];
  const upstream = new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const e of events) c.enqueue(encoder.encode(e));
        c.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
  const converted = convertStreamResponse(upstream, "openai->anthropic", "m");
  const text = await new Response(converted.body!).text();
  assert(
    text.includes('"object":"chat.completion.chunk"'),
    "anthropic SSE converted to openai chunk stream",
  );
  assert(text.includes("[DONE]"), "openai stream carries terminal [DONE]");
}

section("Finish/stop reason maps");

{
  assert(stopReasonToFinishReason("end_turn") === "stop", "end_turn → stop");
  assert(stopReasonToFinishReason("max_tokens") === "length", "max_tokens → length");
  assert(stopReasonToFinishReason("tool_use") === "tool_calls", "tool_use → tool_calls");
  assert(finishReasonToStopReason("stop") === "end_turn", "stop → end_turn");
  assert(finishReasonToStopReason("length") === "max_tokens", "length → max_tokens");
  assert(finishReasonToStopReason("tool_calls") === "tool_use", "tool_calls → tool_use");
}

/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
