import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createRuzMcpServer } from "./mcp-server.js";

const PORT = Number(process.env.PORT ?? 8790);

/**
 * RÚZ publishes open data, so the server runs authless by default: every MCP client
 * (Cowork, Claude Code, Codex, ChatGPT) can connect with a bare URL. Set
 * MCP_AUTH_MODE=bearer to put a static token in front of it — note that Cowork and
 * claude.ai custom connectors cannot send custom headers, so bearer mode limits you
 * to Claude Code / Codex.
 */
const AUTH_MODE = process.env.MCP_AUTH_MODE === "bearer" ? "bearer" : "authless";
const BEARER_TOKEN = process.env.MCP_BEARER_TOKEN;

/** Public base URL, used to build the RFC 9728 resource identifier. */
const PUBLIC_URL = (process.env.MCP_PUBLIC_URL ?? "").replace(/\/+$/, "");
/** Optional OAuth issuer, advertised via RFC 9728 when you front this with an AS. */
const AUTHORIZATION_SERVER = process.env.MCP_AUTHORIZATION_SERVER;

if (AUTH_MODE === "bearer" && !BEARER_TOKEN) {
  process.stderr.write(
    "[ruz-mcp] ERROR: MCP_AUTH_MODE=bearer but MCP_BEARER_TOKEN is not set. Exiting.\n"
  );
  process.exit(1);
}

// --- Rate limiting -----------------------------------------------------------
// Fixed window per client IP. Keeps an open endpoint from being used to hammer
// the upstream RÚZ API, which is the only reason this server needs a limiter.
const RATE_LIMIT = Number(process.env.MCP_RATE_LIMIT ?? 120);
const RATE_WINDOW_MS = Number(process.env.MCP_RATE_WINDOW_MS ?? 60_000);
const hits = new Map<string, { count: number; resetAt: number }>();

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const raw = Array.isArray(fwd) ? fwd[0] : fwd;
  return (raw?.split(",")[0] ?? req.socket.remoteAddress ?? "unknown").trim();
}

function rateLimited(req: IncomingMessage): boolean {
  if (RATE_LIMIT <= 0) return false;
  const key = clientIp(req);
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || now >= entry.resetAt) {
    hits.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT;
}

// Drop expired buckets so the map cannot grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of hits) if (now >= entry.resetAt) hits.delete(key);
}, RATE_WINDOW_MS).unref();

// --- Helpers -----------------------------------------------------------------
function isAuthorized(req: IncomingMessage): boolean {
  if (AUTH_MODE !== "bearer") return true;
  return !!BEARER_TOKEN && req.headers.authorization === `Bearer ${BEARER_TOKEN}`;
}

function resourceUrl(req: IncomingMessage): string {
  if (PUBLIC_URL) return `${PUBLIC_URL}/mcp`;
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
  return `${proto}://${req.headers.host ?? `localhost:${PORT}`}/mcp`;
}

function cors(res: ServerResponse) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "access-control-allow-headers",
    "content-type, authorization, mcp-session-id, mcp-protocol-version, last-event-id"
  );
  res.setHeader("access-control-expose-headers", "mcp-session-id, mcp-protocol-version");
  res.setHeader("access-control-max-age", "86400");
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

// --- Server ------------------------------------------------------------------
const httpServer = createServer(async (req, res) => {
  cors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const path = (req.url ?? "/").split("?")[0];

  if (req.method === "GET" && path === "/healthz") {
    sendJson(res, 200, { status: "ok", service: "ruz-mcp", auth: AUTH_MODE });
    return;
  }

  // RFC 9728 Protected Resource Metadata — how a spec-compliant MCP client
  // discovers which authorization server guards this resource.
  if (
    req.method === "GET" &&
    (path === "/.well-known/oauth-protected-resource" ||
      path === "/.well-known/oauth-protected-resource/mcp")
  ) {
    sendJson(res, 200, {
      resource: resourceUrl(req),
      authorization_servers: AUTHORIZATION_SERVER ? [AUTHORIZATION_SERVER] : [],
      bearer_methods_supported: ["header"],
      resource_documentation: "https://github.com/originalmagneto/RUZ-MCP",
    });
    return;
  }

  if (path === "/mcp" || path.startsWith("/mcp/")) {
    if (rateLimited(req)) {
      sendJson(
        res,
        429,
        { jsonrpc: "2.0", error: { code: -32029, message: "Rate limit exceeded" }, id: null },
        { "retry-after": String(Math.ceil(RATE_WINDOW_MS / 1000)) }
      );
      return;
    }

    if (!isAuthorized(req)) {
      const metadata = `${PUBLIC_URL || `https://${req.headers.host}`}/.well-known/oauth-protected-resource`;
      sendJson(
        res,
        401,
        { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null },
        { "www-authenticate": `Bearer realm="mcp", resource_metadata="${metadata}"` }
      );
      return;
    }

    const mcpServer = createRuzMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      mcpServer.close();
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }

  sendJson(res, 404, { error: "not_found" });
});

httpServer.listen(PORT, () => {
  console.error(
    `ruz-mcp HTTP listening on :${PORT} (/mcp, /healthz) [auth=${AUTH_MODE}, rateLimit=${RATE_LIMIT}/${RATE_WINDOW_MS}ms]`
  );
});
