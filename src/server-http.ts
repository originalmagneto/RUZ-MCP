import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createRuzMcpServer } from "./mcp-server.js";

const PORT = Number(process.env.PORT ?? 8790);

const httpServer = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (req.url?.startsWith("/mcp")) {
    const mcpServer = createRuzMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); mcpServer.close(); });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }
  res.writeHead(404);
  res.end();
});

httpServer.listen(PORT, () => {
  console.error(`ruz-mcp HTTP listening on :${PORT} (/mcp, /healthz)`);
});
