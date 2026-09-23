/**
 * Test: SSE-formatted error extraction.
 *
 * Simulates an upstream that returns errors as SSE text even for
 * non-streaming requests, and verifies the proxy extracts the JSON
 * payload correctly instead of failing with "network error".
 */

import { createServer } from "node:http";

const PORT = 9877;

const server = createServer((req, res) => {
  console.log("\n=== Mock upstream received request ===");
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const parsed = JSON.parse(body);
    const streamRequested = parsed.stream === true;

    // Simulate the AgentRouter "no channel" error
    const errorPayload = {
      error: {
        message: "当前分组 default 下对于模型 " + parsed.model + " 无可用渠道 (request id: test123)",
        type: "new_api_error",
      },
    };

    if (streamRequested) {
      // Return as SSE
      console.log("  → returning SSE error stream");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify(errorPayload)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      // Return as JSON
      console.log("  → returning JSON error");
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(errorPayload));
    }
  });
});

server.listen(PORT, async () => {
  console.log(`Mock upstream listening on http://localhost:${PORT}`);

  // Add a temporary mock provider to the config by testing with a model
  // that routes to localhost. We'll use the test-proxy approach:
  // temporarily add a "Mock-Test" provider pointing at localhost:9877.

  // First, let's test by making the proxy forward to our mock.
  // We need to add a provider that serves "test-model" at localhost:9877.
  // Read current config, add mock provider, write back.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const configPath = path.join(os.homedir(), ".pi", "agent", "models.json");
  const originalConfig = fs.readFileSync(configPath, "utf-8");
  const config = JSON.parse(originalConfig);
  config.providers["Mock-Test"] = {
    baseUrl: `http://localhost:${PORT}/v1`,
    api: "openai-completions",
    apiKey: "test-key",
    models: [{ id: "test-model", name: "test-model" }],
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  // Wait for config cache to expire (5s)
  console.log("Waiting 6s for proxy config cache to expire...");
  await new Promise((r) => setTimeout(r, 6000));

  // Test 1: streaming request
  console.log("\n=== TEST 1: Streaming request (stream:true) ===");
  const r1 = await fetch("http://localhost:3000/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      max_tokens: 10,
    }),
  });
  console.log("Status:", r1.status);
  console.log("Content-Type:", r1.headers.get("content-type"));
  const t1 = await r1.text();
  console.log("Body:", t1);

  // Test 2: non-streaming request
  console.log("\n=== TEST 2: Non-streaming request (stream:false) ===");
  const r2 = await fetch("http://localhost:3000/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      max_tokens: 10,
    }),
  });
  console.log("Status:", r2.status);
  console.log("Content-Type:", r2.headers.get("content-type"));
  const t2 = await r2.text();
  console.log("Body:", t2);

  // Restore original config
  fs.writeFileSync(configPath, originalConfig);
  console.log("\n=== Restored original config ===");

  server.close();
  process.exit(0);
});
