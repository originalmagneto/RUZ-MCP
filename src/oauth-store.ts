import crypto from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isSha256Hex, isValidOAuthRedirectUri, isValidOAuthResourceUrl, isValidOAuthScope } from "./oauth-validation.js";

export type TokenRecord = { clientId: string; scopes: string[]; expiresAt: number; resource: string };
export type RegisteredClient = { client_id: string; redirect_uris: string[]; token_endpoint_auth_method: "none" };
export type StoredClient = RegisteredClient & { registeredAt?: number; expiresAt?: number; lastUsedAt?: number; registrationKeyHash?: string };
type Persisted = { version: 1; access: Record<string, TokenRecord>; refresh: Record<string, TokenRecord>; clients: Record<string, StoredClient> };
const EMPTY_STATE = (): Persisted => ({ version: 1, access: {}, refresh: {}, clients: {} });
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const isSafePositiveInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const exactKeys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every((key) => allowed.includes(key));
const validScopes = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.length <= 32 && new Set(value).size === value.length && value.every(isValidOAuthScope);

export const hashOAuthToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

export class OAuthClientQuotaError extends Error {
  constructor(message = "Dynamic OAuth client registration quota is full.") { super(message); }
}

export class OAuthGrantQuotaError extends Error {
  constructor(message = "OAuth live grant quota is full.") { super(message); }
}

function validateTokenRecord(value: unknown): value is TokenRecord {
  if (!isRecord(value) || !exactKeys(value, ["clientId", "scopes", "expiresAt", "resource"])) return false;
  return typeof value.clientId === "string" && value.clientId.length > 0 && value.clientId.length <= 256 && validScopes(value.scopes) && isSafePositiveInt(value.expiresAt) && isValidOAuthResourceUrl(value.resource);
}

function validateClient(key: string, value: unknown, legacy: boolean): value is StoredClient {
  if (!isRecord(value) || !exactKeys(value, ["client_id", "redirect_uris", "token_endpoint_auth_method", "registeredAt", "expiresAt", "lastUsedAt", "registrationKeyHash"])) return false;
  if (value.client_id !== key || typeof value.client_id !== "string" || value.client_id.length === 0 || value.client_id.length > 256 || value.token_endpoint_auth_method !== "none") return false;
  if (!Array.isArray(value.redirect_uris) || value.redirect_uris.length < 1 || value.redirect_uris.length > 16 || new Set(value.redirect_uris).size !== value.redirect_uris.length || value.redirect_uris.some((uri) => typeof uri !== "string" || uri.length > 2_048 || !isValidOAuthRedirectUri(uri))) return false;
  if (!legacy && (!isSafePositiveInt(value.registeredAt) || !isSafePositiveInt(value.expiresAt) || !isSafePositiveInt(value.lastUsedAt) || !isSha256Hex(value.registrationKeyHash))) return false;
  if (value.registeredAt !== undefined && !isSafePositiveInt(value.registeredAt)) return false;
  if (value.expiresAt !== undefined && !isSafePositiveInt(value.expiresAt)) return false;
  if (value.registeredAt !== undefined && value.expiresAt !== undefined && value.expiresAt < value.registeredAt) return false;
  if (value.lastUsedAt !== undefined && !isSafePositiveInt(value.lastUsedAt)) return false;
  if (value.registrationKeyHash !== undefined && !isSha256Hex(value.registrationKeyHash)) return false;
  return true;
}

function validatePersisted(value: unknown): Persisted {
  if (!isRecord(value) || !exactKeys(value, ["version", "access", "refresh", "clients"]) || (value.version !== undefined && value.version !== 1) || !isRecord(value.access) || !isRecord(value.refresh) || !isRecord(value.clients)) throw new Error("Persistent OAuth state is malformed.");
  const legacy = value.version === undefined;
  for (const [key, record] of Object.entries(value.access)) if (!/^[a-f0-9]{64}$/.test(key) || !validateTokenRecord(record)) throw new Error("Persistent OAuth state is malformed.");
  for (const [key, record] of Object.entries(value.refresh)) if (!/^[a-f0-9]{64}$/.test(key) || !validateTokenRecord(record)) throw new Error("Persistent OAuth state is malformed.");
  for (const [key, client] of Object.entries(value.clients)) if (!validateClient(key, client, legacy)) throw new Error("Persistent OAuth state is malformed.");
  return { version: 1, access: value.access as Record<string, TokenRecord>, refresh: value.refresh as Record<string, TokenRecord>, clients: value.clients as Record<string, StoredClient> };
}

/** Single-replica atomic store. Any durable failure marks the instance unhealthy. */
export class FileOAuthStore {
  private data: Persisted = EMPTY_STATE();
  private depth = 0;
  private dirty = false;
  private failed = false;

  constructor(private readonly filePath: string) { this.reload(); }

  /** Explicit durability probe used at startup and by the periodic readiness check. */
  probeReady() { this.assertHealthy(); this.reload(); this.writeAtomically(this.data); return true; }
  /** Backwards-compatible health read; the HTTP layer uses its own cached probe result. */
  isReady() { return !this.failed; }

  getAccess(key: string) { this.assertHealthy(); this.reloadIfIdle(); return this.data.access[key]; }
  setAccess(key: string, value: TokenRecord) { this.mutate(() => { this.data.access[key] = structuredClone(value); }); }
  deleteAccess(key: string) { this.mutate(() => { delete this.data.access[key]; }); }
  getRefresh(key: string) { this.assertHealthy(); this.reloadIfIdle(); return this.data.refresh[key]; }
  setRefresh(key: string, value: TokenRecord) { this.mutate(() => { this.data.refresh[key] = structuredClone(value); }); }
  deleteRefresh(key: string) { this.mutate(() => { delete this.data.refresh[key]; }); }
  getClient(key: string, currentTime?: number) {
    this.assertHealthy();
    this.reloadIfIdle();
    const client = this.data.clients[key];
    if (client && currentTime !== undefined && typeof client.expiresAt === "number" && client.expiresAt <= currentTime) {
      this.transaction(() => { delete this.data.clients[key]; this.dirty = true; });
      return undefined;
    }
    return client;
  }
  setClient(key: string, value: StoredClient) { this.mutate(() => { this.data.clients[key] = structuredClone(value); }); }

  initializeClientPolicy(currentTime: number, maxClients: number, unusedTtlSeconds: number, activeTtlSeconds: number) {
    this.transaction(() => {
      for (const [key, client] of Object.entries(this.data.clients)) {
        if (typeof client.registeredAt !== "number" || typeof client.expiresAt !== "number" || typeof client.lastUsedAt !== "number" || !isSha256Hex(client.registrationKeyHash)) {
          this.data.clients[key] = { ...client, registeredAt: typeof client.registeredAt === "number" ? client.registeredAt : currentTime, expiresAt: typeof client.expiresAt === "number" ? client.expiresAt : currentTime + activeTtlSeconds, lastUsedAt: typeof client.lastUsedAt === "number" ? client.lastUsedAt : currentTime, registrationKeyHash: isSha256Hex(client.registrationKeyHash) ? client.registrationKeyHash : hashOAuthToken(`legacy:${key}`) };
          this.dirty = true;
        }
      }
      this.pruneExpiredClients(currentTime);
      if (Object.keys(this.data.clients).length > maxClients) throw new OAuthClientQuotaError("Persistent OAuth client quota exceeds the configured bound.");
    });
  }

  registerClient(value: RegisteredClient, registrationKeyHash: string, currentTime: number, maxClients: number, maxClientsPerIdentity: number, unusedTtlSeconds: number) {
    this.transaction(() => {
      this.pruneExpiredClients(currentTime);
      const identityCount = Object.values(this.data.clients).filter((client) => client.registrationKeyHash === registrationKeyHash).length;
      if (identityCount >= maxClientsPerIdentity) throw new OAuthClientQuotaError("Dynamic OAuth client registration quota for this network identity is full.");
      if (Object.keys(this.data.clients).length >= maxClients) throw new OAuthClientQuotaError();
      this.data.clients[value.client_id] = { ...structuredClone(value), registeredAt: currentTime, expiresAt: currentTime + unusedTtlSeconds, lastUsedAt: currentTime, registrationKeyHash };
      this.dirty = true;
    });
  }

  markClientActive(clientId: string, currentTime: number, activeTtlSeconds: number) {
    this.transaction(() => {
      this.pruneExpiredClients(currentTime);
      const client = this.data.clients[clientId];
      if (!client) throw new Error("OAuth client is not registered.");
      this.data.clients[clientId] = { ...client, lastUsedAt: currentTime, expiresAt: currentTime + activeTtlSeconds };
      this.dirty = true;
    });
  }

  issueTokenPair(accessKey: string, access: TokenRecord, refreshKey: string, refresh: TokenRecord, currentTime: number, maxLiveGrants: number, maxLiveGrantsPerClient: number) {
    this.transaction(() => {
      this.pruneExpiredTokens(currentTime);
      const globalCount = Object.keys(this.data.access).length + Object.keys(this.data.refresh).length;
      const clientCount = Object.values(this.data.access).filter((record) => record.clientId === access.clientId).length + Object.values(this.data.refresh).filter((record) => record.clientId === access.clientId).length;
      const additionalGlobal = (this.data.access[accessKey] ? 0 : 1) + (this.data.refresh[refreshKey] ? 0 : 1);
      if (globalCount + additionalGlobal > maxLiveGrants) throw new OAuthGrantQuotaError();
      if (clientCount + additionalGlobal > maxLiveGrantsPerClient) throw new OAuthGrantQuotaError("OAuth live grant quota for this client is full.");
      this.data.access[accessKey] = structuredClone(access);
      this.data.refresh[refreshKey] = structuredClone(refresh);
      this.dirty = true;
    });
  }

  pruneExpired(currentTime: number) {
    return this.transaction(() => {
      const { access, refresh } = this.pruneExpiredTokens(currentTime);
      let clients = 0;
      clients = this.pruneExpiredClients(currentTime);
      return { access, refresh, clients };
    });
  }

  transaction<T>(action: () => T): T {
    this.assertHealthy();
    const outer = this.depth === 0;
    if (outer) this.reload();
    const committed = this.data;
    const staged = outer ? structuredClone(committed) : this.data;
    if (outer) this.data = staged;
    const snapshot = structuredClone(this.data);
    const dirtyBefore = this.dirty;
    this.depth += 1;
    let result: T;
    try { result = action(); } catch (error) {
      this.data = outer ? committed : snapshot;
      this.dirty = dirtyBefore;
      this.depth -= 1;
      throw error;
    }
    this.depth -= 1;
    if (outer && this.dirty) {
      try { this.writeAtomically(staged); this.data = staged; this.dirty = false; } catch (error) { this.data = committed; this.dirty = false; throw error; }
    }
    return result!;
  }

  private mutate(action: () => void) { if (this.depth > 0) { action(); this.dirty = true; return; } this.transaction(() => { action(); this.dirty = true; }); }
  private reloadIfIdle() { if (this.depth === 0) this.reload(); }
  private assertHealthy() { if (this.failed) throw new Error("Persistent OAuth store is unhealthy."); }
  private pruneExpiredTokens(currentTime: number) {
    let access = 0, refresh = 0;
    for (const [key, record] of Object.entries(this.data.access)) if (record.expiresAt <= currentTime) { delete this.data.access[key]; access += 1; this.dirty = true; }
    for (const [key, record] of Object.entries(this.data.refresh)) if (record.expiresAt <= currentTime) { delete this.data.refresh[key]; refresh += 1; this.dirty = true; }
    return { access, refresh };
  }
  private pruneExpiredClients(currentTime: number) { let count = 0; for (const [key, client] of Object.entries(this.data.clients)) if (typeof client.expiresAt === "number" && client.expiresAt <= currentTime) { delete this.data.clients[key]; count += 1; this.dirty = true; } return count; }
  private reload() {
    try { this.data = validatePersisted(JSON.parse(readFileSync(this.filePath, "utf8")) as unknown); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.data = EMPTY_STATE(); return; }
      this.failed = true;
      if (error instanceof Error && error.message === "Persistent OAuth state is malformed.") throw error;
      throw new Error("Cannot read persistent OAuth state.", { cause: error });
    }
  }
  private writeAtomically(payload: Persisted) {
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let fileDescriptor: number | undefined;
    let directoryDescriptor: number | undefined;
    try {
      validatePersisted(payload);
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(temporary, JSON.stringify(payload), { mode: 0o600, flag: "wx" });
      chmodSync(temporary, 0o600);
      fileDescriptor = openSync(temporary, "r");
      fsyncSync(fileDescriptor);
      closeSync(fileDescriptor);
      fileDescriptor = undefined;
      renameSync(temporary, this.filePath);
      directoryDescriptor = openSync(dirname(this.filePath), "r");
      fsyncSync(directoryDescriptor);
      closeSync(directoryDescriptor);
      directoryDescriptor = undefined;
    } catch (error) {
      if (fileDescriptor !== undefined) try { closeSync(fileDescriptor); } catch { /* preserve original error */ }
      if (directoryDescriptor !== undefined) try { closeSync(directoryDescriptor); } catch { /* preserve original error */ }
      try { unlinkSync(temporary); } catch { /* it may already have been renamed */ }
      this.failed = true;
      throw new Error("Cannot persist OAuth state.", { cause: error });
    }
  }
}
