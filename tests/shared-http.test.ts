import { request as httpRequest } from "node:http";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { setTimeout as delay } from "node:timers/promises";
import { currentIdentity } from "../src/skallars-auth.js";

import { test } from "vitest";

test("shared HTTP verifies every request, isolates identity and retains transport contracts", async () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, {
    MCP_AUTH_MODE: "shared-oauth", MCP_PUBLIC_BASE_URL: "https://legacy.example",
    SKALLARS_AUTH_ISSUER: "https://auth.example", SKALLARS_AUTH_RESOURCE: "https://synthetic.example/mcp",
    SKALLARS_AUTH_SECRET: "synthetic-secret-for-tests-000000000000", SKALLARS_AUTH_ALLOWED_ORIGINS: "https://client.example",
  });
  let introspections = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input) !== "https://auth.example/resource/introspect") throw new Error("Unexpected source network request");
    introspections++;
    const token = new URLSearchParams(String(init?.body)).get("token");
    return new Response(JSON.stringify({ active: token !== "invalid", iss: "https://auth.example",
      aud: token === "wrong-audience" ? "https://other.example/mcp" : "https://synthetic.example/mcp",
      sub: token?.startsWith("bob") ? "bob" : "alice", tenant: token === "alice-other-tenant" ? "other" : "synthetic", scope: "mcp:tools", exp: Math.floor(Date.now()/1000)+60 }), { headers: {"content-type":"application/json"} });
  };
  const { createHttpServer } = await import("../src/server-http.js");
  const fixture = () => {
    const mcp = new McpServer({name:"synthetic",version:"1"});
    mcp.registerTool("identity_probe", {inputSchema:{}}, async () => {
      await delay(15);
      return { content: [{type:"text" as const, text:JSON.stringify(currentIdentity())}] };
    });
    return mcp;
  };
  const app = createHttpServer(fixture);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  let url = `http://127.0.0.1:${address.port}`;
  const request = (path="/mcp", token="alice", method="POST", body: unknown = {jsonrpc:"2.0",id:1,method:"tools/list"}, session?: string, extra: Record<string,string> = {}) => new Promise<Response>((resolve, reject) => {
    const req = httpRequest(url+path, {method, headers: {host:"synthetic.example", accept:"application/json, text/event-stream", "content-type":"application/json", ...(token ? {authorization:`Bearer ${token}`} : {}), ...(session ? {"mcp-session-id":session} : {}), ...extra}}, res => {
      const chunks: Buffer[] = []; res.on("data", c => chunks.push(Buffer.from(c))); res.on("end", () => {
        const headers = new Headers(); for (const [key,value] of Object.entries(res.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(",") : value);
        resolve(new Response([204,304].includes(res.statusCode!) ? null : Buffer.concat(chunks), {status:res.statusCode,headers}));
      });
    }); req.on("error",reject); req.end(method === "POST" ? JSON.stringify(body) : undefined);
  });
  const json = async (response: Response) => { const raw = await response.text(); const data = raw.startsWith("event:") ? raw.split("\n").find(line=>line.startsWith("data: "))!.slice(6) : raw; return JSON.parse(data); };
  try {
    const absent = await request("/mcp", "");
    assert.equal(absent.status,401); assert.equal(absent.headers.get("www-authenticate"), 'Bearer resource_metadata="https://synthetic.example/.well-known/oauth-protected-resource/mcp"');
    assert.equal((await request("/mcp","wrong-audience")).status,401);
    const calls = introspections;
    assert.equal((await request("/mcp", "alice", "OPTIONS", undefined, undefined, {host:"evil.example"})).status,403);
    assert.equal((await request("/mcp", "alice", "OPTIONS", undefined, undefined, {origin:"https://evil.example"})).status,403);
    assert.equal(introspections,calls);
    assert.equal((await request("/mcp", "alice", "OPTIONS", undefined, undefined, {origin:"https://client.example"})).status,204);
    const metadata = await json(await request("/.well-known/oauth-protected-resource/mcp","","GET"));
    assert.equal(metadata.resource,"https://synthetic.example/mcp"); assert.deepEqual(metadata.authorization_servers,["https://auth.example"]);
    const discovery = await request("/.well-known/oauth-authorization-server", "", "GET");
    assert.equal(discovery.headers.get("location"),"https://auth.example/.well-known/oauth-authorization-server");
    assert.equal((await request("/register","", "POST", {})).status,404);
    const health = await json(await request("/healthz","","GET"));
    assert.equal(health.auth,"shared-oauth"); assert.equal(health.sharedReady,true);
    const initialize = async (token: string) => {
      const response = await request("/mcp",token,"POST",{jsonrpc:"2.0",id:2,method:"initialize",params:{protocolVersion:"2025-03-26", capabilities:{},clientInfo:{name:"synthetic",version:"1"}}});
      assert.equal(response.status,200); await response.text(); return response.headers.get("mcp-session-id") ?? undefined;
    };
    const alice = await initialize("alice"), bob = await initialize("bob");
    const discoveryTools = await json(await request("/mcp","alice","POST",{jsonrpc:"2.0",id:3,method:"tools/list"},alice));
    assert.equal(discoveryTools.result.tools[0].name,"identity_probe");
    const call = (token: string, session?:string) => request("/mcp",token,"POST",{jsonrpc:"2.0",id:4,method:"tools/call",params:{name:"identity_probe",arguments:{}}},session).then(json);
    const results = await Promise.all([call("alice",alice),call("bob",bob)]);
    assert.equal(JSON.parse(results[0].result.content[0].text).sub,"alice");
    assert.equal(JSON.parse(results[1].result.content[0].text).sub,"bob");
    assert.equal(currentIdentity(),undefined);
    if (alice) {
      for (const token of ["bob", "alice-other-tenant"]) for (const method of ["GET","POST","DELETE"]) assert.equal((await request("/mcp",token,method,undefined,alice)).status,403);
      assert.equal((await request("/mcp","invalid","POST",undefined,alice)).status,401);
      assert.equal(JSON.parse((await call("alice-refresh",alice)).result.content[0].text).sub,"alice");
      assert.equal((await request("/mcp","alice","POST",undefined,"unknown")).status,400);
      assert.equal((await request("/mcp","alice","DELETE",undefined,alice)).status,200);
      assert.equal((await request("/mcp","alice","POST",undefined,alice)).status,400);
      await request("/mcp","bob","DELETE",undefined,bob);
    }
    assert(introspections >= 6);
    const beforeRepeat = introspections;
    await call("bob", bob);
    assert.equal(introspections, beforeRepeat + 1);
    const oversized = await request("/mcp","alice","POST", {large:"x".repeat(1024*1024+1)});
    assert.equal(oversized.status,413);
    const realApp = createHttpServer();
    const realServer = realApp.listen(0, "127.0.0.1");
    await new Promise<void>(resolve=>realServer.once("listening",resolve));
    const realAddress = realServer.address(); assert(realAddress && typeof realAddress !== "string");
    url = `http://127.0.0.1:${realAddress.port}`;
    try {
      const session = await initialize("alice");
      const result = await json(await request("/mcp","alice","POST",{jsonrpc:"2.0",id:8,method:"tools/list"},session));
      assert(result.result.tools.length > 0);
      assert(!result.result.tools.some((tool: {name:string})=>tool.name === "identity_probe"));
      if (session) await request("/mcp","alice","DELETE",undefined,session);
    } finally {
      realServer.closeAllConnections(); await new Promise<void>(resolve=>realServer.close(()=>resolve()));
    }

  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve()));
    globalThis.fetch=originalFetch;
    process.env=originalEnv;
  }
});

test("HTTP startup rejects invalid mode and incomplete shared configuration", async () => {
  const { spawnSync } = await import("node:child_process");
  for (const overrides of [{MCP_AUTH_MODE:"oauth", OAUTH_ISSUER_URL:"https://legacy.example", MCP_PUBLIC_BASE_URL:"https://legacy.example", OAUTH_AUTHORIZATION_PASSWORD:"", OAUTH_TOKEN_STORE_PATH:"/tmp/synthetic-unused-store.json", OAUTH_STATE_FILE:"/tmp/synthetic-unused-store.json", OAUTH_ENABLE_DYNAMIC_CLIENT_REGISTRATION:"true"}, {MCP_AUTH_MODE:"typo"}, {MCP_AUTH_MODE:"shared-oauth"}, {MCP_AUTH_MODE:"oauth",SKALLARS_AUTH_SECRET:"synthetic-partial"}, {MCP_AUTH_MODE:"shared-oauth",SKALLARS_AUTH_ISSUER:"https://auth.example",SKALLARS_AUTH_RESOURCE:"https://synthetic.example/",SKALLARS_AUTH_SECRET:"synthetic-secret-00000000000000000000"}]) {
    const env = {...process.env,MCP_PUBLIC_BASE_URL:"",SKALLARS_AUTH_ISSUER:"",SKALLARS_AUTH_RESOURCE:"",SKALLARS_AUTH_SECRET:"",SKALLARS_AUTH_ALLOWED_ORIGINS:"", ...overrides};
    const result = spawnSync(process.execPath,["--import","tsx","src/server-http.ts"],{env,timeout:10000,encoding:"utf8"});
    assert.equal(result.status,1,result.stderr);
  }
});
