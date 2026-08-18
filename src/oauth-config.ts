import { isValidOAuthScope } from "./oauth-validation.js";

/**
 * OAuth nastavenia pre remote HTTP režim. Zámerne fail-closed: ak je zapnutý
 * OAuth a čokoľvek podstatné chýba, server radšej nenabehne, než by bežal
 * nechránený. RÚZ síce sprístupňuje verejné dáta, ale server je náš.
 */
export type RuzOAuthConfig = {
  issuerUrl: string;
  tokenStorePath: string;
  authorizationPassword: string;
  scopes: string[];
  enableDcr: boolean;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  codeTtlSeconds: number;
  loginSessionTtlSeconds: number;
  maxBodyBytes: number;
  maxDynamicClients: number;
  unusedClientTtlSeconds: number;
  activeClientTtlSeconds: number;
  maxClientsPerIdentity: number;
  maxLiveGrants: number;
  maxLiveGrantsPerClient: number;
  readinessCheckIntervalSeconds: number;
  trustedProxyCidrs: string;
};

function positive(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive number.`);
  return value;
}

export function loadRuzOAuthConfig(env: NodeJS.ProcessEnv = process.env): RuzOAuthConfig {
  const issuerUrl = (env.OAUTH_ISSUER_URL ?? env.MCP_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  if (!issuerUrl) throw new Error("OAuth mode requires OAUTH_ISSUER_URL or MCP_PUBLIC_URL.");
  if (!issuerUrl.startsWith("https://")) throw new Error("OAUTH_ISSUER_URL must be an https:// origin.");

  const tokenStorePath = (env.OAUTH_TOKEN_STORE_PATH ?? "").trim();
  if (!tokenStorePath) throw new Error("OAuth mode requires OAUTH_TOKEN_STORE_PATH on persistent storage.");

  const authorizationPassword = (env.OAUTH_AUTHORIZATION_PASSWORD ?? "").trim();
  if (authorizationPassword.length < 16) {
    throw new Error("OAuth mode requires OAUTH_AUTHORIZATION_PASSWORD with at least 16 characters.");
  }

  const scopes = (env.OAUTH_SCOPES ?? "mcp:tools").split(/\s+/).filter(Boolean);
  if (!scopes.length || !scopes.every(isValidOAuthScope)) throw new Error("OAUTH_SCOPES contains an invalid scope.");

  return {
    issuerUrl,
    tokenStorePath,
    authorizationPassword,
    scopes,
    enableDcr: (env.OAUTH_ENABLE_DYNAMIC_CLIENT_REGISTRATION ?? "true").trim().toLowerCase() === "true",
    accessTtlSeconds: positive(env.OAUTH_ACCESS_TOKEN_TTL_SECONDS, 3_600, "OAUTH_ACCESS_TOKEN_TTL_SECONDS"),
    refreshTtlSeconds: positive(env.OAUTH_REFRESH_TOKEN_TTL_SECONDS, 15_552_000, "OAUTH_REFRESH_TOKEN_TTL_SECONDS"),
    codeTtlSeconds: positive(env.OAUTH_AUTHORIZATION_CODE_TTL_SECONDS, 300, "OAUTH_AUTHORIZATION_CODE_TTL_SECONDS"),
    loginSessionTtlSeconds: positive(env.OAUTH_LOGIN_SESSION_TTL_SECONDS, 86_400, "OAUTH_LOGIN_SESSION_TTL_SECONDS"),
    maxBodyBytes: positive(env.MCP_MAX_BODY_BYTES, 1_048_576, "MCP_MAX_BODY_BYTES"),
    maxDynamicClients: positive(env.OAUTH_MAX_DYNAMIC_CLIENTS, 256, "OAUTH_MAX_DYNAMIC_CLIENTS"),
    unusedClientTtlSeconds: positive(env.OAUTH_UNUSED_CLIENT_TTL_SECONDS, 3_600, "OAUTH_UNUSED_CLIENT_TTL_SECONDS"),
    activeClientTtlSeconds: positive(env.OAUTH_DYNAMIC_CLIENT_TTL_SECONDS, 2_592_000, "OAUTH_DYNAMIC_CLIENT_TTL_SECONDS"),
    maxClientsPerIdentity: positive(env.OAUTH_MAX_CLIENTS_PER_IDENTITY, 8, "OAUTH_MAX_CLIENTS_PER_IDENTITY"),
    maxLiveGrants: positive(env.OAUTH_MAX_LIVE_GRANTS, 512, "OAUTH_MAX_LIVE_GRANTS"),
    maxLiveGrantsPerClient: positive(env.OAUTH_MAX_LIVE_GRANTS_PER_CLIENT, 64, "OAUTH_MAX_LIVE_GRANTS_PER_CLIENT"),
    readinessCheckIntervalSeconds: positive(env.OAUTH_READINESS_CHECK_INTERVAL_SECONDS, 30, "OAUTH_READINESS_CHECK_INTERVAL_SECONDS"),
    trustedProxyCidrs: (env.TRUSTED_PROXY_CIDRS ?? "").trim(),
  };
}
