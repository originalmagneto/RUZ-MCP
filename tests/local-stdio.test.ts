import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { bindLocalStdioIdentity } from "../src/local-stdio.js";
import { currentIdentity } from "../src/skallars-auth.js";
import { test } from "vitest";

test("local identity reaches a delayed actual SDK stdio callback", async () => {
  const input = new PassThrough(), output = new PassThrough();
  const transport = new StdioServerTransport(input, output);
  const server = new McpServer({name:"synthetic-stdio",version:"1"});
  server.registerTool("identity_probe", {inputSchema:{}}, async () => {
    await new Promise(resolve=>setTimeout(resolve,10));
    return {content:[{type:"text" as const,text:JSON.stringify(currentIdentity())}]};
  });
  await server.connect(transport);
  bindLocalStdioIdentity(transport);
  const message = (payload:unknown) => new Promise<any>((resolve,reject) => {
    const timeout = setTimeout(()=>reject(new Error("stdio timeout")),2000);
    output.once("data",data=>{clearTimeout(timeout);resolve(JSON.parse(String(data)));});
    input.write(JSON.stringify(payload)+"\n");
  });
  try {
    await message({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"synthetic",version:"1"}}});
    await new Promise(resolve=>setTimeout(resolve,10));
    const result = await message({jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"identity_probe",arguments:{}}});
    assert.equal(JSON.parse(result.result.content[0].text),"local");
    assert.equal(currentIdentity(),undefined);
  } finally { await server.close(); }
});
