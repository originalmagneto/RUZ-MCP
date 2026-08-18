import crypto from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";
import { dirname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRateLimiter, type RateLimiter } from "./rate-limiter.js";
import { FileOAuthStore, OAuthClientQuotaError, OAuthGrantQuotaError } from "./oauth-store.js";
import { OAuthProvider } from "./oauth-provider.js";

type Options = { issuer: string; storePath: string; password: string; scopes: string[]; requiredScopes: string[]; accessTtlSeconds: number; refreshTtlSeconds: number; codeTtlSeconds: number; loginSessionTtlSeconds: number; enableDcr: boolean; maxBodyBytes: number; maxDynamicClients: number; unusedClientTtlSeconds: number; activeClientTtlSeconds: number; maxClientsPerIdentity: number; maxLiveGrants: number; maxLiveGrantsPerClient: number; readinessCheckIntervalMs: number; requestKey: (request: IncomingMessage) => string };
type Pending = { clientId: string; redirectUri: string; state?: string | undefined; codeChallenge: string; scopes: string[]; resource: string; expiresAt: number };
type LoginTicket = { returnTo: string; expiresAt: number };
const MAX_PENDING = 1_024;
const MAX_LOGIN_TICKETS = 1_024;
const json = (res: ServerResponse, code: number, body: unknown) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
const escape = (value: string) => value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
const cookies = (raw: string | undefined) => Object.fromEntries((raw ?? "").split(";").map((entry) => entry.trim().split("=", 2)).filter(([key]) => key));
async function bodyText(req: IncomingMessage, limit: number) { const chunks: Buffer[] = []; let total = 0; for await (const part of req) { const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part); total += chunk.length; if (total > limit) { req.resume(); throw new Error("Request body is too large."); } chunks.push(chunk); } return Buffer.concat(chunks).toString("utf8"); }
async function form(req: IncomingMessage, limit: number) { return new URLSearchParams(await bodyText(req, limit)); }
const safeEqual = (left: string, right: string) => { const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const validChallenge = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);
const prune = <T extends { expiresAt: number }>(map: Map<string, T>, currentTime: number, limit: number) => { for (const [key, value] of map) if (value.expiresAt <= currentTime) map.delete(key); while (map.size >= limit) map.delete(map.keys().next().value!); };

/** OAuth routing is separate from MCP session state; it never alters query workers or the cache. */
export function createOAuthHttp(options: Options) {
  accessSync(dirname(options.storePath), fsConstants.W_OK);
  const store = new FileOAuthStore(options.storePath);
  const provider = new OAuthProvider({ scopes: options.scopes, requiredScopes: options.requiredScopes, accessTtlSeconds: options.accessTtlSeconds, refreshTtlSeconds: options.refreshTtlSeconds, codeTtlSeconds: options.codeTtlSeconds, store, resource: new URL("/mcp", options.issuer).href, maxDynamicClients: options.maxDynamicClients, unusedClientTtlSeconds: options.unusedClientTtlSeconds, activeClientTtlSeconds: options.activeClientTtlSeconds, maxClientsPerIdentity: options.maxClientsPerIdentity, maxLiveGrants: options.maxLiveGrants, maxLiveGrantsPerClient: options.maxLiveGrantsPerClient });
  const pending = new Map<string, Pending>();
  const loginTickets = new Map<string, LoginTicket>();
  const sensitiveLimits: Record<string, RateLimiter> = {
    "/oauth/login": createRateLimiter({ ratePerMinute: 10, burst: 5, maxKeys: 2_048 }),
    "/register": createRateLimiter({ ratePerMinute: 10, burst: 5, maxKeys: 2_048 }),
    "/token": createRateLimiter({ ratePerMinute: 30, burst: 10, maxKeys: 2_048 })
  };
  const key = crypto.createHash("sha256").update(`${options.issuer}\0${options.password}`).digest();
  const sign = (value: string) => crypto.createHmac("sha256", key).update(value).digest("base64url");
  const cookie = (name: string, value: string, age: number) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
  const loggedIn = (request: IncomingMessage) => { const raw = cookies(request.headers.cookie).judikaty_oauth_login; const [expiry, signature] = (raw ?? "").split("."); return Number(expiry) > Math.floor(Date.now() / 1000) && signature === sign(`login:${expiry}`); };
  const pageHeaders = (res: ServerResponse) => { res.setHeader("cache-control", "no-store"); res.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"); res.setHeader("x-frame-options", "DENY"); };
  const authorizationError = (res: ServerResponse, message: string) => json(res, 400, { error: "invalid_request", error_description: message });
  const limited = (request: IncomingMessage, response: ServerResponse, url: URL) => { const limiter = sensitiveLimits[url.pathname]; if (!limiter) return false; const decision = limiter.check(`${url.pathname}:${options.requestKey(request)}`); if (decision.allowed) return false; response.statusCode = 429; response.setHeader("retry-after", String(decision.retryAfterSeconds)); response.end(); return true; };
  let readiness = false;
  try { store.probeReady(); readiness = true; } catch { readiness = false; }
  const refreshState = () => {
    try {
      const current = Math.floor(Date.now() / 1000);
      provider.pruneExpired();
      prune(pending, current, MAX_PENDING);
      prune(loginTickets, current, MAX_LOGIN_TICKETS);
      store.probeReady();
      readiness = true;
    } catch { readiness = false; }
  };
  const timer = setInterval(refreshState, options.readinessCheckIntervalMs);
  timer.unref();
  return {
    ready: () => readiness,
    close: () => clearInterval(timer),
    authenticate: (request: IncomingMessage) => { const [scheme, token] = (request.headers.authorization ?? "").split(" "); if (scheme?.toLowerCase() !== "bearer" || !token) return null; try { return provider.verifyAccess(token); } catch { return null; } },
    async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
      if (url.pathname === "/.well-known/oauth-authorization-server") return json(response, 200, { issuer: options.issuer, authorization_endpoint: new URL("/authorize", options.issuer).href, token_endpoint: new URL("/token", options.issuer).href, registration_endpoint: options.enableDcr ? new URL("/register", options.issuer).href : undefined, revocation_endpoint: new URL("/revoke", options.issuer).href, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], scopes_supported: options.scopes }), true;
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return json(response, 200, { resource: new URL("/mcp", options.issuer).href, authorization_servers: [options.issuer], scopes_supported: options.scopes }), true;
      if (limited(request, response, url)) return true;
      if (url.pathname === "/register" && request.method === "POST") { if (!options.enableDcr) return json(response, 403, { error: "access_denied" }), true; try { const raw = await bodyText(request, options.maxBodyBytes); const body = JSON.parse(request.headers["content-type"]?.includes("application/json") ? raw : new URLSearchParams(raw).get("client_metadata") ?? "{}"); return json(response, 201, provider.registerClient(body, options.requestKey(request))), true; } catch (error) { if (error instanceof OAuthClientQuotaError) { response.setHeader("retry-after", "3600"); return json(response, 429, { error: "temporarily_unavailable", error_description: error.message }), true; } return authorizationError(response, error instanceof Error ? error.message : "Invalid client metadata"), true; } }
      if (url.pathname === "/authorize" && request.method === "GET") {
        const clientId = url.searchParams.get("client_id") ?? ""; const redirectUri = url.searchParams.get("redirect_uri") ?? ""; const codeChallenge = url.searchParams.get("code_challenge") ?? ""; const requestedScopes = (url.searchParams.get("scope") ?? "").split(/\s+/).filter(Boolean); const resource = url.searchParams.get("resource") ?? ""; const state = url.searchParams.get("state") ?? undefined;
        try { if (url.searchParams.get("response_type") !== "code" || url.searchParams.get("code_challenge_method") !== "S256" || !validChallenge(codeChallenge) || clientId.length > 256 || redirectUri.length > 2_048 || !requestedScopes.length || requestedScopes.join(" ").length > 256 || !resource || (state?.length ?? 0) > 1_024 || !provider.getClient(clientId)?.redirect_uris.includes(redirectUri)) throw new Error("Invalid OAuth authorization request"); provider.validateRequest(requestedScopes, resource); }
        catch (error) { return authorizationError(response, error instanceof Error ? error.message : "Invalid OAuth authorization request"), true; }
        pageHeaders(response);
        const current = Math.floor(Date.now() / 1000);
        if (!loggedIn(request)) { prune(loginTickets, current, MAX_LOGIN_TICKETS); const ticket = crypto.randomBytes(24).toString("base64url"); loginTickets.set(ticket, { returnTo: url.pathname + url.search, expiresAt: current + 120 }); response.statusCode = 200; response.setHeader("content-type", "text/html; charset=utf-8"); response.end(`<!doctype html><html lang="sk"><meta charset="utf-8"><title>Judikáty MCP prihlásenie</title><form method="post" action="/oauth/login"><h1>Judikáty MCP</h1><p>Pre pokračovanie zadajte autorizačné heslo.</p><input type="password" name="password" required autofocus><input type="hidden" name="ticket" value="${ticket}"><button>Prihlásiť sa</button></form></html>`); return true; }
        prune(pending, current, MAX_PENDING); const nonce = crypto.randomBytes(24).toString("base64url"); pending.set(nonce, { clientId, redirectUri, state, codeChallenge, scopes: requestedScopes, resource, expiresAt: current + 120 }); response.statusCode = 200; response.setHeader("content-type", "text/html; charset=utf-8"); response.end(`<!doctype html><html lang="sk"><meta charset="utf-8"><title>Povoliť Judikáty MCP</title><form method="post" action="/oauth/consent"><h1>Povoliť MCP klienta?</h1><p>Klient: ${escape(clientId)}<br>Presmerovanie: ${escape(redirectUri)}<br>Oprávnenia: ${escape(requestedScopes.join(" "))}</p><input type="hidden" name="nonce" value="${nonce}"><button name="decision" value="allow">Povoliť</button><button name="decision" value="deny">Zamietnuť</button></form></html>`); return true;
      }
      if (url.pathname === "/oauth/login" && request.method === "POST") { pageHeaders(response); const body = await form(request, options.maxBodyBytes); const ticketKey = body.get("ticket") ?? ""; const ticket = loginTickets.get(ticketKey); if (!ticket || ticket.expiresAt <= Math.floor(Date.now() / 1000)) return authorizationError(response, "Authorization login expired"), true; loginTickets.delete(ticketKey); if (!safeEqual(body.get("password") ?? "", options.password)) return json(response, 401, { error: "invalid_login" }), true; const expiry = Math.floor(Date.now() / 1000) + options.loginSessionTtlSeconds; response.statusCode = 303; response.setHeader("set-cookie", cookie("judikaty_oauth_login", `${expiry}.${sign(`login:${expiry}`)}`, options.loginSessionTtlSeconds)); response.setHeader("location", ticket.returnTo); response.end(); return true; }
      if (url.pathname === "/oauth/consent" && request.method === "POST") { pageHeaders(response); const body = await form(request, options.maxBodyBytes); const record = pending.get(body.get("nonce") ?? ""); if (!loggedIn(request) || !record || record.expiresAt <= Math.floor(Date.now() / 1000)) return authorizationError(response, "Authorization session expired"), true; pending.delete(body.get("nonce") ?? ""); if (body.get("decision") !== "allow") return json(response, 403, { error: "access_denied" }), true; try { const code = provider.authorize({ ...record, codeChallengeMethod: "S256" }); const redirect = new URL(record.redirectUri); redirect.searchParams.set("code", code); if (record.state) redirect.searchParams.set("state", record.state); response.statusCode = 303; response.setHeader("location", redirect.href); response.end(); return true; } catch (error) { return authorizationError(response, error instanceof Error ? error.message : "Authorization failed"), true; } }
      if (url.pathname === "/token" && request.method === "POST") { const body = await form(request, options.maxBodyBytes); try { const resource = body.get("resource") ?? ""; const scopes = (body.get("scope") ?? "").split(/\s+/).filter(Boolean); const tokens = body.get("grant_type") === "authorization_code" ? provider.exchangeCode({ clientId: body.get("client_id") ?? "", code: body.get("code") ?? "", redirectUri: body.get("redirect_uri") ?? "", codeVerifier: body.get("code_verifier") ?? "", resource }) : body.get("grant_type") === "refresh_token" ? provider.refresh({ clientId: body.get("client_id") ?? "", refreshToken: body.get("refresh_token") ?? "", scopes: scopes.length ? scopes : undefined, resource }) : null; if (!tokens) return authorizationError(response, "Unsupported grant type"), true; return json(response, 200, tokens), true; } catch (error) { if (error instanceof OAuthGrantQuotaError) { response.setHeader("retry-after", "60"); return json(response, 429, { error: "temporarily_unavailable", error_description: error.message }), true; } return json(response, 400, { error: "invalid_grant", error_description: error instanceof Error ? error.message : "Token exchange failed" }), true; } }
      if (url.pathname === "/revoke" && request.method === "POST") { const body = await form(request, options.maxBodyBytes); provider.revoke(body.get("client_id") ?? "", body.get("token") ?? ""); response.statusCode = 200; response.end(); return true; }
      return false;
    }
  };
}
