import { isIP } from "node:net";

type ParsedIp = { family: 4 | 6; value: bigint; normalized: string };
export type TrustedProxyCidr = { family: 4 | 6; network: bigint; prefix: number };

function parseIPv4(value: string): ParsedIp | undefined {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return undefined;
  const octets = parts.map(Number);
  return { family: 4, value: (BigInt(octets[0]!) << 24n) | (BigInt(octets[1]!) << 16n) | (BigInt(octets[2]!) << 8n) | BigInt(octets[3]!), normalized: octets.join(".") };
}

function parseIPv6(value: string): ParsedIp | undefined {
  if (value.includes("%")) return undefined;
  const halves = value.split("::");
  if (halves.length > 2) return undefined;
  const parseWords = (part: string): number[] => {
    if (!part) return [];
    const words: number[] = [];
    for (const segment of part.split(":")) {
      if (segment.includes(".")) {
        const ipv4 = parseIPv4(segment);
        if (!ipv4) return [];
        words.push(Number((ipv4.value >> 16n) & 0xffffn), Number(ipv4.value & 0xffffn));
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(segment)) return [];
        words.push(Number.parseInt(segment, 16));
      }
    }
    return words;
  };
  const left = parseWords(halves[0]!);
  const right = parseWords(halves[1] ?? "");
  if ((halves.length === 1 && left.length !== 8) || (halves.length === 2 && left.length + right.length >= 8)) return undefined;
  const words = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right] : left;
  let valueNumber = 0n;
  for (const word of words) valueNumber = (valueNumber << 16n) | BigInt(word);
  const mapped = (valueNumber >> 32n) === 0xffffn && (valueNumber >> 48n) === 0n;
  if (mapped) return parseIPv4(`${Number((valueNumber >> 24n) & 255n)}.${Number((valueNumber >> 16n) & 255n)}.${Number((valueNumber >> 8n) & 255n)}.${Number(valueNumber & 255n)}`);
  return { family: 6, value: valueNumber, normalized: words.map((word) => word.toString(16)).join(":") };
}

function parseIp(value: string): ParsedIp | undefined {
  const trimmed = value.trim().replace(/^\[|\]$/g, "");
  const family = isIP(trimmed);
  if (family === 4) return parseIPv4(trimmed);
  if (family === 6) return parseIPv6(trimmed);
  return undefined;
}

function matches(cidr: TrustedProxyCidr, ip: ParsedIp): boolean {
  if (cidr.family !== ip.family) return false;
  const bits = cidr.family === 4 ? 32 : 128;
  if (cidr.prefix === 0) return true;
  const shift = BigInt(bits - cidr.prefix);
  return (ip.value >> shift) === (cidr.network >> shift);
}

export function parseTrustedProxyCidrs(value: string): TrustedProxyCidr[] {
  if (!value.trim()) return [];
  return value.split(",").map((entry) => {
    const parts = entry.trim().split("/");
    if (parts.length > 2) throw new Error(`Invalid trusted proxy IP/CIDR: ${entry}`);
    const [address, prefixText] = parts;
    const ip = parseIp(address ?? "");
    if (!ip) throw new Error(`Invalid trusted proxy IP/CIDR: ${entry}`);
    const bits = ip.family === 4 ? 32 : 128;
    if (prefixText !== undefined && !/^\d+$/.test(prefixText)) throw new Error(`Invalid trusted proxy prefix: ${entry}`);
    const prefix = prefixText === undefined ? bits : Number(prefixText);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) throw new Error(`Invalid trusted proxy prefix: ${entry}`);
    return { family: ip.family, network: ip.value, prefix };
  });
}

export function resolveClientAddress(remoteAddress: string | undefined, forwardedFor: string | string[] | undefined, trustedProxies: TrustedProxyCidr[]): string {
  const direct = remoteAddress ? parseIp(remoteAddress) : undefined;
  if (!direct) return "unknown";
  if (!trustedProxies.some((cidr) => matches(cidr, direct))) return direct.normalized;
  const raw = Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor ?? "";
  const forwarded = raw.split(",").filter(Boolean).map((value) => parseIp(value));
  if (forwarded.some((value) => !value)) return direct.normalized;
  const chain = [...forwarded as ParsedIp[], direct];
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const address = chain[index]!;
    if (!trustedProxies.some((cidr) => matches(cidr, address))) return address.normalized;
  }
  return direct.normalized;
}
