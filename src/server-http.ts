import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createRuzMcpServer } from "./mcp-server.js";

const PORT = Number(process.env.PORT ?? 8790);

const AUTH_MODE = process.env.MCP_AUTH_MODE === "bearer" ? "bearer" : "authless";
const BEARER_TOKEN = process.env.MCP_BEARER_TOKEN;

if (AUTH_MODE === "bearer" && !BEARER_TOKEN) {
  process.stderr.write(
    "[ruz-mcp] ERROR: MCP_AUTH_MODE=bearer but MCP_BEARER_TOKEN is not set. Exiting.\n"
  );
  process.exit(1);
}

function isAuthorized(req: import("node:http").IncomingMessage): boolean {
  if (AUTH_MODE !== "bearer") return true;
  const auth = req.headers.authorization;
  return !!BEARER_TOKEN && auth === `Bearer ${BEARER_TOKEN}`;
}

const httpServer = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (req.url?.startsWith("/mcp")) {
    if (!isAuthorized(req)) {
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": 'Bearer realm="mcp"',
      });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
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
  console.error(`ruz-mcp HTTP listening on :${PORT} (/mcp, /healthz) [auth=${AUTH_MODE}]`);
});
