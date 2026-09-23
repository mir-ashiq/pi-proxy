// Test if Node's native fetch (which Pi uses) gets through the WAF.
const API_KEY = process.env.PI_GATEWAY_API_KEY || "";
if (!API_KEY) {
  console.error("Set PI_GATEWAY_API_KEY in your environment before running this script.");
  process.exit(1);
}

const url = "https://agentrouter.org/v1/chat/completions";
const body = {
  model: "deepseek-v4-flash",
  messages: [{ role: "user", content: "hi" }],
  max_tokens: 5,
  stream: false,
};

console.log("Test 1: Plain fetch, no UA");
try {
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  console.log("  Status:", r.status);
  console.log("  Content-Type:", r.headers.get("content-type"));
  console.log("  Body length:", text.length);
  console.log("  Body preview:", text.slice(0, 150));
  console.log("  Is WAF:", text.includes("aliyun_waf_aa"));
} catch (e) {
  console.log("  Error:", (e as Error).message);
}

console.log("\nTest 2: fetch with User-Agent: pi/0.87.1");
try {
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      "User-Agent": "pi/0.87.1",
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  console.log("  Status:", r.status);
  console.log("  Body length:", text.length);
  console.log("  Is WAF:", text.includes("aliyun_waf_aa"));
  if (!text.includes("aliyun_waf_aa")) {
    console.log("  Body preview:", text.slice(0, 300));
  }
} catch (e) {
  console.log("  Error:", (e as Error).message);
}

console.log("\nTest 3: Try ps.air-outer.com");
try {
  const r = await fetch("https://ps.air-outer.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      "User-Agent": "pi/0.87.1",
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  console.log("  Status:", r.status);
  console.log("  Body length:", text.length);
  console.log("  Is WAF:", text.includes("aliyun_waf_aa"));
  if (!text.includes("aliyun_waf_aa")) {
    console.log("  Body preview:", text.slice(0, 300));
  }
} catch (e) {
  console.log("  Error:", (e as Error).message);
}
