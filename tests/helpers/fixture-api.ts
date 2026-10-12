import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RuzClient } from "../../src/ruz-client.js";
import { createRuzMcpServer } from "../../src/mcp-server.js";

/**
 * Responses captured from https://www.registeruz.sk/cruz-public/api on
 * 2026-10-09/12 and stored under tests/fixtures/api. Natural persons filed
 * under IČO 99999999 are anonymised (nazovUJ, dic, mesto, psc); ids and
 * figures are as the register returned them.
 */
const API_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "api");

export function loadApi<T = unknown>(rel: string): T {
  return JSON.parse(readFileSync(join(API_DIR, rel), "utf8")) as T;
}

/** Map a RÚZ API URL to its captured fixture file, or null if not captured. */
function fixtureFor(url: URL): string | null {
  const endpoint = url.pathname.split("/api/")[1];
  const q = url.searchParams;
  if (endpoint === "uctovne-jednotky") {
    if ((q.get("pokracovat-za-id") ?? "0") !== "0") return null;
    return q.get("ico") ? `uctovne-jednotky/ico-${q.get("ico")}.json` : null;
  }
  if (endpoint === "velkosti-organizacie" || endpoint === "pravne-formy") return `${endpoint}.json`;
  const id = q.get("id");
  if (id && ["uctovna-jednotka", "uctovna-zavierka", "uctovny-vykaz", "sablona"].includes(endpoint)) {
    return `${endpoint}/${id}.json`;
  }
  return null;
}

/** fetch() that serves only captured fixtures; anything else is a 404. */
export function fixtureFetch(calls: string[] = []): typeof fetch {
  return (async (input: string | URL) => {
    const url = new URL(input.toString());
    calls.push(url.toString());
    const rel = fixtureFor(url);
    if (!rel || !existsSync(join(API_DIR, rel))) {
      return new Response(`fixture missing for ${url.pathname}${url.search}`, { status: 404 });
    }
    return new Response(readFileSync(join(API_DIR, rel), "utf8"), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

/** Connect an MCP client to the server backed by the captured fixtures. */
export async function fixtureMcp(
  fetchImpl: typeof fetch = fixtureFetch(),
  options?: Parameters<typeof createRuzMcpServer>[1],
) {
  const server = createRuzMcpServer(new RuzClient({ fetchImpl }), options);
  const client = new Client({ name: "fixture-test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    async call<T = any>(name: string, args: Record<string, unknown>): Promise<T> {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as Array<{ type: string; text: string }>)[0].text;
      if (res.isError) throw new Error(text);
      return JSON.parse(text) as T;
    },
    close: () => client.close(),
  };
}
