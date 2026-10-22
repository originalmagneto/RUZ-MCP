import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

// Synthetic configuration only; CI runs this container without external networking.
assert.equal(process.version, "v24.22.1");
const child = spawn(process.execPath, ["dist/server-http.js"], {
  env: {
    ...process.env,
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: "3000",
    MCP_AUTH_MODE: "shared-oauth",
    SKALLARS_AUTH_ISSUER: "https://auth.example.test",
    SKALLARS_AUTH_RESOURCE: "https://ruz.example.test/mcp",
    SKALLARS_AUTH_SECRET: "synthetic-container-smoke-secret-0000000000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", chunk => { logs += chunk; });
child.stderr.on("data", chunk => { logs += chunk; });
const read = (path, method = "GET", body) => new Promise((resolve, reject) => {
  const req = request({ hostname: "127.0.0.1", port: 3000, path, method,
    headers: { host: "ruz.example.test", "content-type": "application/json", accept: "application/json, text/event-stream" },
    timeout: 1000,
  }, res => {
    let text = "";
    res.on("data", chunk => { text += chunk; });
    res.on("end", () => resolve({ status: res.statusCode, body: text }));
  });
  req.on("timeout", () => req.destroy(new Error("request timeout")));
  req.on("error", reject);
  req.end(body === undefined ? undefined : JSON.stringify(body));
});
try {
  let health;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${logs}`);
    try { health = await read("/healthz"); if (health.status === 200) break; } catch {}
    await delay(100);
  }
  assert.equal(health?.status, 200, logs);
  const status = JSON.parse(health.body);
  assert.equal(status.auth, "shared-oauth");
  assert.equal(status.sharedReady, true);
  const metadata = await read("/.well-known/oauth-protected-resource/mcp");
  assert.equal(metadata.status, 200);
  assert.equal(JSON.parse(metadata.body).resource, "https://ruz.example.test/mcp");
  const mcp = await read("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "synthetic", version: "1" } } });
  assert.equal(mcp.status, 401);
  console.log(JSON.stringify({ node: process.version, brotli: process.versions.brotli, productionSmoke: "passed" }));
} finally {
  if (child.exitCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    await exited;
    clearTimeout(timer);
  }
}
