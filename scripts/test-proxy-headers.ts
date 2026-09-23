/**
 * Test: verify the proxy sends the correct headers to the upstream.
 *
 * This script starts a tiny HTTP server that captures the request
 * headers, then makes a request through the proxy pointing at that
 * server, and prints what the proxy actually sent.
 */

import { createServer } from "node:http";

const PORT = 9876;

const server = createServer((req, res) => {
  console.log("\n=== Request received by test upstream ===");
  console.log("Method:", req.method);
  console.log("URL:", req.url);
  console.log("Headers:");
  for (const [key, value] of Object.entries(req.headers)) {
    const display = key.toLowerCase().includes("auth") || key.toLowerCase().includes("api-key")
      ? String(value).slice(0, 15) + "..."
      : value;
    console.log(`  ${key}: ${display}`);
  }

  // Read the body
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    console.log("Body:", body.slice(0, 200));
    // Return a fake OpenAI response
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "test-response",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "test-model",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "Test response from mock upstream" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    }));
  });
});

server.listen(PORT, () => {
  console.log(`Mock upstream listening on http://localhost:${PORT}`);

  // Now make a request through the proxy
  console.log("\n=== Making request through proxy ===");

  const proxyBody = JSON.stringify({
    model: "test-model",
    messages: [{ role: "user", content: "hi" }],
    stream: false,
    max_tokens: 10,
  });

  fetch("http://localhost:3000/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "curl/8.0.0",  // simulate a non-Pi client
      "X-Stainless-Lang": "js",
      "X-Stainless-Package-Version": "4.20.0",
      "anthropic-beta": "test-beta",
    },
    body: proxyBody,
  })
    .then((r) => {
      console.log("\n=== Proxy response status:", r.status);
      return r.text();
    })
    .then((text) => {
      console.log("=== Proxy response body:", text.slice(0, 300));
      server.close();
      process.exit(0);
    })
    .catch((e) => {
      console.error("Error:", e.message);
      server.close();
      process.exit(1);
    });
});
