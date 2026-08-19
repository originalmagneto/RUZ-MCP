import type {
  Entity, EntityIdsResponse, Statement, Report, Template, AnnualReport,
} from "./types.js";

/**
 * RÚZ serves its outage page as HTML with **HTTP 200**, so res.ok says nothing.
 * Feeding that to JSON.parse surfaced `Unexpected token '<', "<!DOCTYPE "...`,
 * which reads like a bug in this server rather than a register that is down.
 */
export class RuzUnavailableError extends Error {
  constructor(path: string) {
    super(
      `Register účtovných závierok je momentálne nedostupný (${path}). ` +
        "Zdroj vrátil HTML stránku namiesto JSON. Skús to neskôr.",
    );
    this.name = "RuzUnavailableError";
  }
}

/** Parse a RÚZ response body, telling an outage page apart from real JSON. */
export function parseRuzJson<T>(body: string, path: string, contentType: string | null): T {
  const trimmed = body.trimStart();
  const looksHtml =
    trimmed.startsWith("<") || (contentType ?? "").toLowerCase().includes("text/html");
  if (looksHtml) {
    throw new RuzUnavailableError(path);
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`RÚZ API ${path} vrátilo odpoveď, ktorá nie je platný JSON.`);
  }
}

const DEFAULT_BASE = "https://www.registeruz.sk/cruz-public/api";
const DEFAULT_WEB_BASE = "https://www.registeruz.sk/cruz-public";

export interface RuzClientOptions {
  baseUrl?: string;
  /** Base URL for the web app (attachment downloads live outside /api). Defaults to https://www.registeruz.sk/cruz-public */
  webBaseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class RuzClient {
  private base: string;
  private webBase: string;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;
  private templateCache = new Map<number, Template>();

  constructor(opts: RuzClientOptions = {}) {
    this.base = opts.baseUrl ?? DEFAULT_BASE;
    this.webBase = opts.webBaseUrl ?? DEFAULT_WEB_BASE;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30000;
  }

  private async getJson<T>(path: string): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.base}${path}`, { signal: ctrl.signal });
      if (!res.ok) {
        throw new Error(`RÚZ API ${path} failed: HTTP ${res.status}`);
      }
      const body = await res.text();
      return parseRuzJson<T>(body, path, res.headers?.get?.("content-type") ?? null);
    } finally {
      clearTimeout(t);
    }
  }

  async findEntityIdsByIco(ico: string): Promise<number[]> {
    const r = await this.getJson<EntityIdsResponse>(
      `/uctovne-jednotky?ico=${encodeURIComponent(ico)}&zmenene-od=2000-01-01&pokracovat-za-id=0&max-zaznamov=20`,
    );
    return r.id ?? [];
  }

  async findEntityIdsByDic(dic: string): Promise<number[]> {
    const r = await this.getJson<EntityIdsResponse>(
      `/uctovne-jednotky?dic=${encodeURIComponent(dic)}&zmenene-od=2000-01-01&pokracovat-za-id=0&max-zaznamov=20`,
    );
    return r.id ?? [];
  }

  getEntity(id: number): Promise<Entity> {
    return this.getJson<Entity>(`/uctovna-jednotka?id=${id}`);
  }

  getStatement(id: number): Promise<Statement> {
    return this.getJson<Statement>(`/uctovna-zavierka?id=${id}`);
  }

  getReport(id: number): Promise<Report> {
    return this.getJson<Report>(`/uctovny-vykaz?id=${id}`);
  }

  getAnnualReport(id: number): Promise<AnnualReport> {
    return this.getJson<AnnualReport>(`/vyrocna-sprava?id=${id}`);
  }

  async getTemplate(id: number): Promise<Template> {
    const cached = this.templateCache.get(id);
    if (cached) return cached;
    const t = await this.getJson<Template>(`/sablona?id=${id}`);
    this.templateCache.set(id, t);
    return t;
  }

  /**
   * Download an attachment's bytes. Returns base64 and content-type.
   *
   * Attachments are served outside the /api prefix, via the web-app path:
   *   GET /cruz-public/domain/financialreport/attachment/{id}
   * (documented at https://www.registeruz.sk/cruz-public/home/api)
   */
  async downloadAttachment(id: number): Promise<{ base64: string; contentType: string }> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const url = `${this.webBase}/domain/financialreport/attachment/${id}`;
      const res = await this.fetchImpl(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`RÚZ príloha ${id} failed: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return {
        base64: buf.toString("base64"),
        contentType: res.headers.get("content-type") ?? "application/octet-stream",
      };
    } finally {
      clearTimeout(t);
    }
  }
}
