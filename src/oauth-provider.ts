import crypto from "node:crypto";
import { FileOAuthStore, hashOAuthToken, type RegisteredClient, type TokenRecord } from "./oauth-store.js";
import { isValidOAuthRedirectUri, isValidOAuthResourceUrl } from "./oauth-validation.js";

type ProviderOptions = { scopes: string[]; requiredScopes: string[]; accessTtlSeconds: number; refreshTtlSeconds: number; codeTtlSeconds: number; store: FileOAuthStore; resource: string; maxDynamicClients?: number; dynamicClientTtlSeconds?: number; unusedClientTtlSeconds?: number; activeClientTtlSeconds?: number; maxClientsPerIdentity?: number; maxAuthorizationCodes?: number; maxLiveGrants?: number; maxLiveGrantsPerClient?: number; now?: () => number };
type Code = { clientId: string; redirectUri: string; challenge: string; scopes: string[]; expiresAt: number; resource: string };
const now = () => Math.floor(Date.now() / 1000);
const token = () => crypto.randomBytes(32).toString("base64url");
const s256 = (verifier: string) => crypto.createHash("sha256").update(verifier).digest("base64url");
const validVerifier = (verifier: string) => /^[A-Za-z0-9._~-]{43,128}$/.test(verifier);
const validChallenge = (challenge: string) => /^[A-Za-z0-9_-]{43}$/.test(challenge);
const DEFAULT_MAX_DYNAMIC_CLIENTS = 256;
const DEFAULT_DYNAMIC_CLIENT_TTL_SECONDS = 2_592_000;
const DEFAULT_UNUSED_CLIENT_TTL_SECONDS = 3_600;
const DEFAULT_MAX_CLIENTS_PER_IDENTITY = 8;
const DEFAULT_MAX_AUTHORIZATION_CODES = 2_048;
const DEFAULT_MAX_LIVE_GRANTS = 512;
const DEFAULT_MAX_LIVE_GRANTS_PER_CLIENT = 16;
const MAX_REDIRECT_URIS = 16;
const MAX_REDIRECT_URI_LENGTH = 2_048;

export class OAuthProvider {
  private readonly codes = new Map<string, Code>();
  private readonly currentTime: () => number;
  private readonly maxDynamicClients: number;
  private readonly unusedClientTtlSeconds: number;
  private readonly activeClientTtlSeconds: number;
  private readonly maxClientsPerIdentity: number;
  private readonly maxAuthorizationCodes: number;
  private readonly maxLiveGrants: number;
  private readonly maxLiveGrantsPerClient: number;
  constructor(private readonly options: ProviderOptions) {
    this.currentTime = options.now ?? now;
    this.maxDynamicClients = options.maxDynamicClients ?? DEFAULT_MAX_DYNAMIC_CLIENTS;
    this.unusedClientTtlSeconds = options.unusedClientTtlSeconds ?? DEFAULT_UNUSED_CLIENT_TTL_SECONDS;
    this.activeClientTtlSeconds = options.activeClientTtlSeconds ?? options.dynamicClientTtlSeconds ?? DEFAULT_DYNAMIC_CLIENT_TTL_SECONDS;
    this.maxClientsPerIdentity = options.maxClientsPerIdentity ?? DEFAULT_MAX_CLIENTS_PER_IDENTITY;
    this.maxAuthorizationCodes = options.maxAuthorizationCodes ?? DEFAULT_MAX_AUTHORIZATION_CODES;
    this.maxLiveGrants = options.maxLiveGrants ?? DEFAULT_MAX_LIVE_GRANTS;
    this.maxLiveGrantsPerClient = options.maxLiveGrantsPerClient ?? DEFAULT_MAX_LIVE_GRANTS_PER_CLIENT;
    if (!isValidOAuthResourceUrl(options.resource) || !Number.isSafeInteger(this.maxDynamicClients) || this.maxDynamicClients < 1 || !Number.isSafeInteger(this.unusedClientTtlSeconds) || this.unusedClientTtlSeconds < 1 || !Number.isSafeInteger(this.activeClientTtlSeconds) || this.activeClientTtlSeconds < 1 || !Number.isSafeInteger(this.maxClientsPerIdentity) || this.maxClientsPerIdentity < 1 || !Number.isSafeInteger(this.maxAuthorizationCodes) || this.maxAuthorizationCodes < 1 || !Number.isSafeInteger(this.maxLiveGrants) || this.maxLiveGrants < 2 || !Number.isSafeInteger(this.maxLiveGrantsPerClient) || this.maxLiveGrantsPerClient < 2) throw new Error("OAuth provider policy is invalid.");
    this.options.store.initializeClientPolicy(this.currentTime(), this.maxDynamicClients, this.unusedClientTtlSeconds, this.activeClientTtlSeconds);
  }

  /** DCR always issues a public client; a client-requested auth method is overridden rather than rejected (RFC 7591 §3.2.1). */
  registerClient(input: Omit<RegisteredClient, "client_id"> & { token_endpoint_auth_method?: string }, registrationKey = "anonymous"): RegisteredClient {
    if (!Array.isArray(input.redirect_uris) || !input.redirect_uris.length || input.redirect_uris.length > MAX_REDIRECT_URIS || new Set(input.redirect_uris).size !== input.redirect_uris.length || input.redirect_uris.some((uri) => typeof uri !== "string" || uri.length > MAX_REDIRECT_URI_LENGTH || !isValidOAuthRedirectUri(uri))) throw new Error("DCR accepts public clients with bounded, unique HTTPS redirect URIs only.");
    const client: RegisteredClient = { client_id: crypto.randomUUID(), redirect_uris: [...input.redirect_uris], token_endpoint_auth_method: "none" };
    this.options.store.registerClient(client, hashOAuthToken(registrationKey), this.currentTime(), this.maxDynamicClients, this.maxClientsPerIdentity, this.unusedClientTtlSeconds);
    return client;
  }

  getClient(clientId: string) { return this.options.store.getClient(clientId, this.currentTime()); }

  authorize(input: { clientId: string; redirectUri: string; codeChallenge: string; codeChallengeMethod?: "S256"; scopes: string[]; resource: string }) {
    const client = this.client(input.clientId);
    this.validateRequest(input.scopes, input.resource);
    if (!client.redirect_uris.includes(input.redirectUri)) throw new Error("redirect URI is not registered.");
    if (!validChallenge(input.codeChallenge) || input.codeChallengeMethod !== "S256") throw new Error("OAuth requires a valid S256 PKCE challenge.");
    this.pruneExpiredCodes();
    if (this.codes.size >= this.maxAuthorizationCodes) throw new Error("Authorization code state quota is full.");
    this.options.store.markClientActive(input.clientId, this.currentTime(), this.activeClientTtlSeconds);
    const code = token();
    this.codes.set(code, { clientId: input.clientId, redirectUri: input.redirectUri, challenge: input.codeChallenge, scopes: input.scopes, expiresAt: this.currentTime() + this.options.codeTtlSeconds, resource: input.resource });
    return code;
  }

  exchangeCode(input: { clientId: string; code: string; redirectUri: string; codeVerifier: string; resource: string }) {
    const record = this.codes.get(input.code);
    if (!record || record.expiresAt <= this.currentTime()) throw new Error("Authorization code is invalid or expired.");
    if (!validVerifier(input.codeVerifier)) throw new Error("PKCE verifier must contain 43 to 128 RFC 7636 unreserved characters.");
    if (record.clientId !== input.clientId || record.redirectUri !== input.redirectUri || record.resource !== input.resource || s256(input.codeVerifier) !== record.challenge) throw new Error("Authorization code validation failed.");
    this.validateRequest(record.scopes, input.resource);
    const tokens = this.issue(input.clientId, record.scopes);
    this.codes.delete(input.code);
    return tokens;
  }

  refresh(input: { clientId: string; refreshToken: string; scopes?: string[] | undefined; resource: string }) {
    return this.options.store.transaction(() => {
      const key = hashOAuthToken(input.refreshToken);
      const record = this.options.store.getRefresh(key);
      if (!record || record.clientId !== input.clientId || record.expiresAt <= this.currentTime() || record.resource !== input.resource) throw new Error("Refresh token is invalid or expired.");
      const scopes = input.scopes?.length ? input.scopes : record.scopes;
      this.validateRequest(scopes, input.resource);
      if (scopes.some((scope) => !record.scopes.includes(scope))) throw new Error("Requested scope exceeds grant.");
      this.options.store.deleteRefresh(key);
      this.options.store.markClientActive(input.clientId, this.currentTime(), this.activeClientTtlSeconds);
      return this.issue(input.clientId, scopes);
    });
  }

  verifyAccess(raw: string) {
    const record = this.options.store.getAccess(hashOAuthToken(raw));
    if (!record || record.expiresAt <= this.currentTime() || record.resource !== this.options.resource) throw new Error("Access token is invalid or expired.");
    this.validateRequest(record.scopes, record.resource);
    return record;
  }

  revoke(clientId: string, raw: string) {
    this.options.store.transaction(() => {
      const key = hashOAuthToken(raw);
      if (this.options.store.getAccess(key)?.clientId === clientId) this.options.store.deleteAccess(key);
      if (this.options.store.getRefresh(key)?.clientId === clientId) this.options.store.deleteRefresh(key);
    });
  }

  pruneExpired() {
    const records = this.options.store.pruneExpired(this.currentTime());
    const codes = this.pruneExpiredCodes();
    return { ...records, codes };
  }

  validateRequest(scopes: string[], resource: string) {
    if (!scopes.length) throw new Error("OAuth scope is required.");
    if (resource !== this.options.resource) throw new Error("OAuth resource mismatch.");
    if (scopes.some((scope) => !this.options.scopes.includes(scope))) throw new Error("Requested scope is not supported.");
    if (this.options.requiredScopes.some((scope) => !scopes.includes(scope))) throw new Error("Required scope is missing.");
  }

  private client(clientId: string) { const client = this.options.store.getClient(clientId, this.currentTime()); if (!client) throw new Error("OAuth client is not registered."); return client; }
  private pruneExpiredCodes() { let count = 0; const current = this.currentTime(); for (const [key, code] of this.codes) if (code.expiresAt <= current) { this.codes.delete(key); count += 1; } return count; }
  private issue(clientId: string, scopes: string[]) {
    return this.options.store.transaction(() => {
      const access = token(), refresh = token();
      const base: Omit<TokenRecord, "expiresAt"> = { clientId, scopes, resource: this.options.resource };
      this.options.store.issueTokenPair(hashOAuthToken(access), { ...base, expiresAt: this.currentTime() + this.options.accessTtlSeconds }, hashOAuthToken(refresh), { ...base, expiresAt: this.currentTime() + this.options.refreshTtlSeconds }, this.currentTime(), this.maxLiveGrants, this.maxLiveGrantsPerClient);
      return { access_token: access, token_type: "Bearer", expires_in: this.options.accessTtlSeconds, refresh_token: refresh, scope: scopes.join(" ") };
    });
  }
}
