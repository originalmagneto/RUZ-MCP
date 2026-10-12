import { pathToFileURL } from "node:url";
import { createSharedAuth, loadSharedAuthConfig, runWithIdentity } from "./skallars-auth.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createRuzMcpServer } from "./mcp-server.js";
import { createOAuthHttp } from "./oauth-http.js";
import { loadRuzOAuthConfig } from "./oauth-config.js";
import { parseTrustedProxyCidrs, resolveClientAddress } from "./trusted-proxy.js";

export function createHttpServer(serverFactory: typeof createRuzMcpServer = createRuzMcpServer) {
const sharedConfig = loadSharedAuthConfig(process.env);
const shared = sharedConfig ? createSharedAuth(sharedConfig) : undefined;
const PORT = Number(process.env.PORT ?? 8790);

/**
 * RÚZ publishes open data, so the server runs authless by default: every MCP client
 * (Cowork, Claude Code, Codex, ChatGPT) can connect with a bare URL. Set
 * MCP_AUTH_MODE=bearer to put a static token in front of it — note that Cowork and
 * claude.ai custom connectors cannot send custom headers, so bearer mode limits you
 * to Claude Code / Codex.
 */
const RAW_AUTH_MODE = process.env.MCP_AUTH_MODE?.trim().toLowerCase();
if (RAW_AUTH_MODE && !["oauth", "shared-oauth", "bearer", "authless"].includes(RAW_AUTH_MODE)) throw new Error("Invalid MCP_AUTH_MODE");
const AUTH_MODE = shared ? "shared-oauth" : RAW_AUTH_MODE === "oauth" ? "oauth" : RAW_AUTH_MODE === "bearer" ? "bearer" : "authless";
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
const rateInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of hits) if (now >= entry.resetAt) hits.delete(key);
}, RATE_WINDOW_MS).unref();

// --- Helpers -----------------------------------------------------------------
function isAuthorized(req: IncomingMessage): boolean {
  if (AUTH_MODE === "oauth") return Boolean(oauth?.authenticate(req));
  if (AUTH_MODE !== "bearer") return true;
  return !!BEARER_TOKEN && req.headers.authorization === `Bearer ${BEARER_TOKEN}`;
}

function resourceUrl(req: IncomingMessage): string {
  if (PUBLIC_URL) return `${PUBLIC_URL}/mcp`;
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
  return `${proto}://${req.headers.host ?? `localhost:${PORT}`}/mcp`;
}

function cors(req: IncomingMessage, res: ServerResponse) {
  if (shared) {
    if (req.headers.origin) { res.setHeader("access-control-allow-origin", req.headers.origin); res.setHeader("vary", "Origin"); }
  } else res.setHeader("access-control-allow-origin", "*");
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

// --- OAuth -------------------------------------------------------------------
/**
 * V OAuth režime chráni server autorizačná brána v prehliadači: klient sa
 * zaregistruje cez DCR, ale authorization code nedostane, kým nezadá heslo
 * a nepotvrdí súhlas. Konfigurácia je fail-closed — pri chýbajúcom hesle
 * alebo úložisku server nenabehne.
 */
const oauthConfig = AUTH_MODE === "oauth" ? loadRuzOAuthConfig() : undefined;
const trustedProxyCidrs = parseTrustedProxyCidrs(oauthConfig?.trustedProxyCidrs ?? "");
const oauth = oauthConfig
  ? createOAuthHttp({
      issuer: oauthConfig.issuerUrl,
      storePath: oauthConfig.tokenStorePath,
      password: oauthConfig.authorizationPassword,
      scopes: oauthConfig.scopes,
      requiredScopes: oauthConfig.scopes.slice(0, 1),
      accessTtlSeconds: oauthConfig.accessTtlSeconds,
      refreshTtlSeconds: oauthConfig.refreshTtlSeconds,
      codeTtlSeconds: oauthConfig.codeTtlSeconds,
      loginSessionTtlSeconds: oauthConfig.loginSessionTtlSeconds,
      enableDcr: oauthConfig.enableDcr,
      maxBodyBytes: oauthConfig.maxBodyBytes,
      maxDynamicClients: oauthConfig.maxDynamicClients,
      unusedClientTtlSeconds: oauthConfig.unusedClientTtlSeconds,
      activeClientTtlSeconds: oauthConfig.activeClientTtlSeconds,
      maxClientsPerIdentity: oauthConfig.maxClientsPerIdentity,
      maxLiveGrants: oauthConfig.maxLiveGrants,
      maxLiveGrantsPerClient: oauthConfig.maxLiveGrantsPerClient,
      readinessCheckIntervalMs: oauthConfig.readinessCheckIntervalSeconds * 1_000,
      requestKey: (request) =>
        resolveClientAddress(request.socket.remoteAddress, request.headers["x-forwarded-for"], trustedProxyCidrs),
    })
  : undefined;

// --- Server ------------------------------------------------------------------
const httpServer = createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  const health = ["/health", "/healthz"].includes(path);
  if (shared && !(health && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "")) && !shared.checkRequest(req)) { sendJson(res, 403, {error: "forbidden"}); return; }
  if (!shared || !health) cors(req, res);
  if (shared && req.method === "GET" && path === "/.well-known/oauth-authorization-server") {
    res.writeHead(302, {location: `${sharedConfig!.issuer}/.well-known/oauth-authorization-server`}).end(); return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (oauth) {
    const url = new URL(req.url ?? "/", `https://${req.headers.host ?? "localhost"}`);
    if (await oauth.handle(req, res, url)) return;
  }

  if (req.method === "GET" && health) {
    sendJson(res, 200, { status: "ok", service: "ruz-mcp", auth: AUTH_MODE, revision: process.env.SOURCE_REVISION ?? "unknown", ...(sharedConfig ? {sharedReady: true, resource: sharedConfig.resource} : {}), ...(oauth ? { oauthReady: oauth.ready() } : {}) });
    return;
  }

  // RFC 9728 Protected Resource Metadata — how a spec-compliant MCP client
  // discovers which authorization server guards this resource.
  if (
    req.method === "GET" &&
    (path === "/.well-known/oauth-protected-resource" ||
      path === "/.well-known/oauth-protected-resource/mcp")
  ) {
    if (shared) { sendJson(res, 200, shared.metadata()); return; }
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

    const identity = shared ? await shared.authenticate(req) : undefined;
    if (shared ? !identity : !isAuthorized(req)) {
      const metadata = `${PUBLIC_URL || `https://${req.headers.host}`}/.well-known/oauth-protected-resource`;
      sendJson(
        res,
        401,
        { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null },
        { "www-authenticate": shared ? shared.challenge : `Bearer realm="mcp", resource_metadata="${metadata}"` }
      );
      return;
    }

    // savePath would write to this server's disk, not the caller's.
    const handle = async () => {
    const body = shared ? await readSharedBody(req) : undefined;
    const mcpServer = serverFactory(undefined, { allowSavePath: false });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      mcpServer.close();
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);
    };
    try { if (identity) await runWithIdentity(identity, handle); else await handle(); }
    catch (error) { if (!res.headersSent) sendJson(res, error instanceof Error && error.message === "body_limit" ? 413 : 500, {error: "request_failed"}); else if (!res.writableEnded) res.end(); }
    return;
  }

  sendJson(res, 404, { error: "not_found" });
});

if (oauth) httpServer.once("close", oauth.close);

httpServer.once("close", () => clearInterval(rateInterval));
return httpServer;
}

async function readSharedBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0, exceeded = false;
    req.on("data", (chunk: Buffer) => {
      if (exceeded) return;
      size += chunk.length;
      if (size > 1024 * 1024) { exceeded = true; chunks.length = 0; reject(new Error("body_limit")); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (exceeded) return;
      try { const raw = Buffer.concat(chunks).toString("utf8"); resolve(raw ? JSON.parse(raw) : undefined); }
      catch (error) { reject(error); }
    });
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("request_aborted")));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const server = createHttpServer(); server.listen(Number(process.env.PORT ?? 8790), () => console.error("ruz-mcp HTTP listening")); }
  catch { console.error("RUZ HTTP startup failed: check authentication configuration"); process.exit(1); }
}
