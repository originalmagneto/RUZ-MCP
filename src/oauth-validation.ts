const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function parsedUrl(value: unknown): URL | undefined {
  if (typeof value !== "string") return undefined;
  try { return new URL(value); } catch { return undefined; }
}

export function isCanonicalIssuerUrl(value: unknown): value is string {
  const parsed = parsedUrl(value);
  return Boolean(parsed && parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && parsed.pathname === "/" && parsed.href === `${parsed.origin}/`);
}

export function isValidOAuthResourceUrl(value: unknown): value is string {
  const parsed = parsedUrl(value);
  return Boolean(parsed && parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && parsed.pathname === "/mcp");
}

export function isValidOAuthRedirectUri(value: unknown): value is string {
  const parsed = parsedUrl(value);
  if (!parsed || parsed.username || parsed.password || parsed.hash) return false;
  if (parsed.protocol === "https:") return true;
  return parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ""));
}

export function isValidOAuthScope(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9:._~-]{1,64}$/.test(value);
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
