// Claude.ai omits token_endpoint_auth_method from its DCR body and omits scope/resource
// from /authorize. Both used to be hard requirements here, which made the connector
// unaddable ("Couldn't register with the sign-in service" / "Invalid OAuth authorization
// request"). These tests pin the tolerant behaviour.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOAuthHttp } from "../src/oauth-http.js";

const ISSUER = "https://mcp.example.test";
const RESOURCE = `${ISSUER}/mcp`;
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "0123456789012345678901234567890123456789012";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const PASSWORD = "a-long-enough-test-password";

let dir: string;
let oauth: ReturnType<typeof createOAuthHttp>;
let server: Server;
let base: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "kalk-oauth-"));
  oauth = createOAuthHttp({
    issuer: ISSUER,
    storePath: join(dir, "oauth.json"),
    password: PASSWORD,
    scopes: ["mcp:tools"],
    requiredScopes: ["mcp:tools"],
    accessTtlSeconds: 60,
    refreshTtlSeconds: 600,
    codeTtlSeconds: 60,
    loginSessionTtlSeconds: 600,
    enableDcr: true,
    maxBodyBytes: 64 * 1024,
    maxDynamicClients: 32,
    unusedClientTtlSeconds: 600,
    activeClientTtlSeconds: 600,
    maxClientsPerIdentity: 16,
    maxLiveGrants: 32,
    maxLiveGrantsPerClient: 16,
    readinessCheckIntervalMs: 60_000,
    requestKey: () => "test",
  });
  server = createServer((request, response) => {
    void oauth
      .handle(request, response, new URL(request.url ?? "/", ISSUER))
      .then((handled) => {
        if (!handled) {
          response.statusCode = 404;
          response.end();
        }
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterEach(async () => {
  oauth.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

const register = (body: Record<string, unknown>) =>
  fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const authorizeUrl = (clientId: string, overrides: Record<string, string | null> = {}) => {
  const url = new URL(`${base}/authorize`);
  const params: Record<string, string> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    scope: "mcp:tools",
    resource: RESOURCE,
    state: "client-state",
  };
  for (const [key, value] of Object.entries({ ...params, ...overrides })) {
    if (value !== null) url.searchParams.set(key, value);
  }
  return url;
};

describe("dynamic client registration", () => {
  it("registers a client that omits token_endpoint_auth_method", async () => {
    const response = await register({ redirect_uris: [REDIRECT_URI], client_name: "Claude" });
    expect(response.status).toBe(201);
    const client = (await response.json()) as Record<string, unknown>;
    expect(client.client_id).toBeTruthy();
    expect(client.token_endpoint_auth_method).toBe("none");
    expect(client.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(client.response_types).toEqual(["code"]);
    expect(client.scope).toBe("mcp:tools");
    expect(client.client_name).toBe("Claude");
    expect(typeof client.client_id_issued_at).toBe("number");
  });

  it("overrides a requested confidential auth method instead of rejecting it", async () => {
    const response = await register({
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "client_secret_post",
    });
    expect(response.status).toBe(201);
    expect((await response.json()).token_endpoint_auth_method).toBe("none");
  });

  it("still rejects a registration without a usable redirect URI", async () => {
    expect((await register({ redirect_uris: [] })).status).toBe(400);
    expect((await register({ redirect_uris: ["http://client.example/cb"] })).status).toBe(400);
  });
});

describe("consent page", () => {
  it("names the client origin in form-action so the approval redirect is not blocked", async () => {
    const clientId = (await (await register({ redirect_uris: [REDIRECT_URI] })).json()).client_id;
    const loginPage = await fetch(authorizeUrl(clientId));
    // The login form only ever posts back to this origin.
    expect(loginPage.headers.get("content-security-policy")).toContain("form-action 'self';");
    const ticket = /name="ticket" value="([^"]+)"/.exec(await loginPage.text())?.[1] ?? "";
    expect(ticket).not.toBe("");
    const login = await fetch(`${base}/oauth/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: PASSWORD, ticket }),
    });
    expect(login.status).toBe(303);
    const cookie = login.headers.get("set-cookie") ?? "";
    const consentPage = await fetch(`${base}${login.headers.get("location")}`, { headers: { cookie } });
    expect(consentPage.status).toBe(200);
    // The consent form's 303 lands on the client's redirect URI, and browsers enforce form-action
    // across that redirect — a bare 'self' silently swallows the approval.
    expect(consentPage.headers.get("content-security-policy")).toContain("form-action 'self' https://claude.ai;");
  });
});

describe("authorization request", () => {
  let clientId: string;

  beforeEach(async () => {
    clientId = (await (await register({ redirect_uris: [REDIRECT_URI] })).json()).client_id;
  });

  it("serves the login page when scope and resource are supplied", async () => {
    expect((await fetch(authorizeUrl(clientId))).status).toBe(200);
  });

  it("defaults a missing scope to the configured scopes", async () => {
    expect((await fetch(authorizeUrl(clientId, { scope: null }))).status).toBe(200);
  });

  it("defaults a missing resource to the canonical MCP resource", async () => {
    expect((await fetch(authorizeUrl(clientId, { resource: null }))).status).toBe(200);
  });

  it("still rejects an unsupported scope, a foreign resource and weak PKCE", async () => {
    expect((await fetch(authorizeUrl(clientId, { scope: "mcp:admin" }))).status).toBe(400);
    expect((await fetch(authorizeUrl(clientId, { resource: "https://other.example/mcp" }))).status).toBe(400);
    expect((await fetch(authorizeUrl(clientId, { code_challenge_method: "plain" }))).status).toBe(400);
    expect((await fetch(authorizeUrl(clientId, { redirect_uri: "https://attacker.example/cb" }))).status).toBe(400);
  });
});
