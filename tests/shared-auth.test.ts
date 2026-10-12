import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import {
  loadSharedAuthConfig,
  createSharedAuth,
  currentIdentity,
  runWithIdentity,
  principalKey,
} from "../src/skallars-auth.js";

const env = {
  MCP_AUTH_MODE: "shared-oauth",
  SKALLARS_AUTH_ISSUER: "https://auth.example.test",
  SKALLARS_AUTH_RESOURCE: "https://synthetic.example.test/mcp",
  SKALLARS_AUTH_SECRET: "s".repeat(32),
};
const claims = {
  active: true,
  iss: env.SKALLARS_AUTH_ISSUER,
  aud: env.SKALLARS_AUTH_RESOURCE,
  sub: "user-1",
  tenant: "tenant-1",
  scope: "mcp:tools",
  exp: Math.floor(Date.now() / 1000) + 60,
};
const request = (
  authorization = "Bearer token",
  host = "synthetic.example.test",
  origin?: string,
) => ({
  headers: { authorization, host, origin },
  rawHeaders: ["Authorization", authorization],
});

describe("shared auth boundary", () => {
  it("requires complete explicit HTTPS configuration", () => {
    expect(loadSharedAuthConfig({})).toBeUndefined();
    expect(loadSharedAuthConfig(env)?.resource).toBe(
      env.SKALLARS_AUTH_RESOURCE,
    );
    for (const key of [
      "SKALLARS_AUTH_ISSUER",
      "SKALLARS_AUTH_RESOURCE",
      "SKALLARS_AUTH_SECRET",
    ])
      expect(() => loadSharedAuthConfig({ ...env, [key]: "" })).toThrow();
    for (const resource of [
      "http://synthetic.example.test/mcp",
      "https://synthetic.example.test/",
      "https://u:p@synthetic.example.test/mcp",
      "https://synthetic.example.test/mcp?x=1",
    ])
      expect(() =>
        loadSharedAuthConfig({ ...env, SKALLARS_AUTH_RESOURCE: resource }),
      ).toThrow();
    expect(() =>
      loadSharedAuthConfig({ ...env, MCP_AUTH_MODE: "oauth" }),
    ).toThrow();
    expect(() =>
      loadSharedAuthConfig({ ...env, SKALLARS_AUTH_ALLOWED_ORIGINS: "*" }),
    ).toThrow();
  });
  it("checks exact metadata, challenge and Host/Origin", async () => {
    const auth = createSharedAuth(loadSharedAuthConfig(env)!);
    expect(auth.metadata()).toEqual({
      resource: env.SKALLARS_AUTH_RESOURCE,
      authorization_servers: [env.SKALLARS_AUTH_ISSUER],
      scopes_supported: ["mcp:tools"],
      bearer_methods_supported: ["header"],
    });
    expect(auth.challenge).toBe(
      'Bearer resource_metadata="https://synthetic.example.test/.well-known/oauth-protected-resource/mcp"',
    );
    expect(auth.checkRequest(request())).toBe(true);
    for (const req of [
      request("Bearer t", "evil.test"),
      request("Bearer t", "synthetic.example.test", "null"),
      request("Bearer t", "synthetic.example.test", "https://evil.test"),
    ])
      expect(auth.checkRequest(req)).toBe(false);
  });
  it("fails closed for token and claim variations, without cache", async () => {
    let response: unknown = claims;
    let calls = 0;
    const fetcher: typeof fetch = async (_url, options) => {
      calls++;
      expect(options?.redirect).toBe("error");
      expect(new URLSearchParams(String(options?.body)).get("resource")).toBe(
        env.SKALLARS_AUTH_RESOURCE,
      );
      return new Response(JSON.stringify(response));
    };
    const auth = createSharedAuth(loadSharedAuthConfig(env)!, {
      fetch: fetcher,
    });
    expect((await auth.authenticate(request()))?.sub).toBe("user-1");
    expect(
      (
        await auth.authenticate({
          ...request(),
          headers: {
            ...request().headers,
            "x-tenant": "attacker",
            "x-sub": "attacker",
          },
        })
      )?.tenant,
    ).toBe("tenant-1");
    for (const override of [
      { active: false },
      { iss: "https://evil.test" },
      { aud: "https://other.test/mcp" },
      { scope: "other" },
      { exp: 0 },
      { exp: 1.5 },
      { tenant: "" },
      { tenant: "../evil" },
      { sub: "" },
    ]) {
      response = { ...claims, ...override };
      expect(await auth.authenticate(request())).toBeUndefined();
    }
    response = claims;
    const before = calls;
    for (const token of [
      "",
      "Bearer",
      "Bearer a b",
      "Bearer " + "x".repeat(4097),
    ])
      expect(await auth.authenticate(request(token))).toBeUndefined();
    expect(calls).toBe(before);
    expect(
      await auth.authenticate({
        ...request(),
        rawHeaders: ["Authorization", "Bearer x", "Authorization", "Bearer y"],
      }),
    ).toBeUndefined();
    for (const body of ["{", "x".repeat(65537), JSON.stringify(null)]) {
      expect(
        await createSharedAuth(loadSharedAuthConfig(env)!, {
          fetch: async () => new Response(body),
        }).authenticate(request()),
      ).toBeUndefined();
    }
    expect(
      await createSharedAuth(loadSharedAuthConfig(env)!, {
        fetch: async () => new Response("{}", { status: 500 }),
      }).authenticate(request()),
    ).toBeUndefined();
  });
  it("uses synthetic HTTP introspection and bounds timeout", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/resource/introspect")
        res.end(JSON.stringify({ ...claims, iss: issuer }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    const issuer = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    try {
      const config = loadSharedAuthConfig(
        { ...env, SKALLARS_AUTH_ISSUER: issuer },
        { allowHttpForTests: true },
      )!;
      expect(
        (await createSharedAuth(config).authenticate(request()))?.issuer,
      ).toBe(issuer);
      const hanging = createSharedAuth(config, {
        timeoutMs: 10,
        fetch: async (_url, opts) =>
          new Promise((_resolve, reject) =>
            opts?.signal?.addEventListener("abort", () =>
              reject(new Error("timeout")),
            ),
          ),
      });
      expect(await hanging.authenticate(request())).toBeUndefined();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
  it("isolates concurrent identity and local execution", async () => {
    const first = {
      issuer: claims.iss,
      resource: claims.aud,
      sub: claims.sub,
      tenant: claims.tenant,
      scope: claims.scope,
      exp: claims.exp,
    };
    const second = { ...first, sub: "user-2", tenant: "tenant-2" };
    expect(principalKey(first)).not.toBe(principalKey(second));
    await Promise.all(
      [first, second].map((identity) =>
        runWithIdentity(identity, async () => {
          await new Promise((r) => setTimeout(r, 5));
          expect(currentIdentity()).toEqual(identity);
        }),
      ),
    );
    expect(currentIdentity()).toBeUndefined();
    runWithIdentity("local", () => expect(currentIdentity()).toBe("local"));
  });
});
