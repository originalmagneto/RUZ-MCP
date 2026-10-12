import { AsyncLocalStorage } from "node:async_hooks";

export interface VerifiedIdentity {
  issuer: string;
  sub: string;
  tenant: string;
  resource: string;
  scope: string;
  exp: number;
}
export interface SharedAuthConfig {
  issuer: string;
  resource: string;
  secret: string;
  allowedOrigins: readonly string[];
}
interface AuthRequest {
  headers: Record<string, string | string[] | undefined>;
  rawHeaders: string[];
}
const identityContext = new AsyncLocalStorage<VerifiedIdentity | "local">();
export const currentIdentity = () => identityContext.getStore();
export const runWithIdentity = <T>(
  identity: VerifiedIdentity | "local",
  callback: () => T,
): T => identityContext.run(identity, callback);
export const principalKey = (identity: VerifiedIdentity): string =>
  JSON.stringify([
    identity.resource,
    identity.issuer,
    identity.sub,
    identity.tenant,
  ]);

function safeUrl(value: string, allowHttp: boolean): URL {
  const url = new URL(value);
  if (
    (!allowHttp && url.protocol !== "https:") ||
    (allowHttp && !["http:", "https:"].includes(url.protocol)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href !== value
  )
    throw new Error("Invalid shared auth URL");
  return url;
}
export function loadSharedAuthConfig(
  env: NodeJS.ProcessEnv,
  options: { allowHttpForTests?: boolean } = {},
): SharedAuthConfig | undefined {
  const mode = env.MCP_AUTH_MODE?.trim().toLowerCase();
  const keys = [
    "SKALLARS_AUTH_ISSUER",
    "SKALLARS_AUTH_RESOURCE",
    "SKALLARS_AUTH_SECRET",
    "SKALLARS_AUTH_ALLOWED_ORIGINS",
  ];
  if (mode !== "shared-oauth") {
    if (keys.some((key) => Boolean(env[key]?.trim())))
      throw new Error("Shared auth configuration requires shared-oauth mode");
    return undefined;
  }
  const issuer = env.SKALLARS_AUTH_ISSUER?.trim() ?? "";
  const resource = env.SKALLARS_AUTH_RESOURCE?.trim() ?? "";
  const secret = env.SKALLARS_AUTH_SECRET?.trim() ?? "";
  const allowHttp = options.allowHttpForTests === true;
  // Issuer is an origin; preserve its exact wire representation without a trailing slash.
  const issuerUrl = safeUrl(`${issuer}/`, allowHttp);
  const resourceUrl = safeUrl(resource, allowHttp);
  if (
    issuerUrl.origin !== issuer ||
    resourceUrl.pathname !== "/mcp" ||
    secret.length < 32 ||
    secret.length > 4096 ||
    /\s/.test(secret)
  )
    throw new Error("Incomplete or invalid shared auth configuration");
  const allowedOrigins = (env.SKALLARS_AUTH_ALLOWED_ORIGINS?.split(",") ?? [])
    .map((s) => s.trim())
    .filter(Boolean);
  for (const origin of allowedOrigins)
    if (safeUrl(`${origin}/`, allowHttp).origin !== origin)
      throw new Error("Invalid shared auth origin");
  return { issuer, resource, secret, allowedOrigins };
}

export function createSharedAuth(
  config: SharedAuthConfig,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
) {
  const resource = new URL(config.resource);
  const metadataUrl = `${resource.origin}/.well-known/oauth-protected-resource/mcp`;
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000)
    throw new Error("Invalid introspection timeout");
  const checkRequest = (request: AuthRequest): boolean => {
    const origin = request.headers.origin;
    return (
      request.headers.host === resource.host &&
      (origin === undefined ||
        (typeof origin === "string" &&
          (origin === resource.origin ||
            config.allowedOrigins.includes(origin))))
    );
  };
  async function authenticate(
    request: AuthRequest,
  ): Promise<VerifiedIdentity | undefined> {
    if (!checkRequest(request)) return undefined;
    if (
      request.rawHeaders.filter(
        (value, index) =>
          index % 2 === 0 && value.toLowerCase() === "authorization",
      ).length !== 1
    )
      return undefined;
    const authorization = request.headers.authorization;
    if (typeof authorization !== "string") return undefined;
    const token = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i.exec(authorization)?.[1];
    if (!token || token.length > 4096) return undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await (options.fetch ?? fetch)(
        `${config.issuer}/resource/introspect`,
        {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            authorization: `Bearer ${config.secret}`,
          },
          body: new URLSearchParams({
            resource: config.resource,
            token,
          }).toString(),
        },
      );
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        return undefined;
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 65536) {
            await reader.cancel();
            return undefined;
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data))
        return undefined;
      const claims = data as Record<string, unknown>;
      if (
        claims.active !== true ||
        claims.iss !== config.issuer ||
        claims.aud !== config.resource ||
        typeof claims.sub !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(claims.sub) ||
        typeof claims.tenant !== "string" ||
        !/^[a-z0-9_-]{1,64}$/.test(claims.tenant) ||
        typeof claims.exp !== "number" ||
        !Number.isSafeInteger(claims.exp) ||
        claims.exp <= Date.now() / 1000 ||
        typeof claims.scope !== "string" ||
        claims.scope.length > 4096 ||
        !claims.scope.split(" ").includes("mcp:tools")
      )
        return undefined;
      return {
        issuer: config.issuer,
        resource: config.resource,
        sub: claims.sub,
        tenant: claims.tenant,
        scope: claims.scope,
        exp: claims.exp,
      };
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }
  return {
    authenticate,
    checkRequest,
    challenge: `Bearer resource_metadata="${metadataUrl}"`,
    metadata: () => ({
      resource: config.resource,
      authorization_servers: [config.issuer],
      scopes_supported: ["mcp:tools"],
      bearer_methods_supported: ["header"],
    }),
  };
}
