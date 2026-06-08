import { describe, it, expect, vi } from "vitest";
import { RuzClient } from "../src/ruz-client.js";

function fakeFetch(map: Record<string, unknown>) {
  return vi.fn(async (url: string | URL) => {
    const u = url.toString();
    const key = Object.keys(map).find((k) => u.includes(k));
    if (!key) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(map[key]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

describe("RuzClient", () => {
  it("finds entity ids by ico", async () => {
    const f = fakeFetch({ "uctovne-jednotky": { id: [154048], existujeDalsieId: false } });
    const c = new RuzClient({ fetchImpl: f as unknown as typeof fetch });
    const ids = await c.findEntityIdsByIco("31333532");
    expect(ids).toEqual([154048]);
    expect((f as any).mock.calls[0][0].toString()).toContain("ico=31333532");
  });

  it("caches templates by id (one fetch for repeated getTemplate)", async () => {
    const f = fakeFetch({ "sablona": { id: 21, nazov: "Súvaha Úč POD 1-01", tabulky: [] } });
    const c = new RuzClient({ fetchImpl: f as unknown as typeof fetch });
    await c.getTemplate(21);
    await c.getTemplate(21);
    expect((f as any).mock.calls.length).toBe(1);
  });

  it("throws a typed error on HTTP failure", async () => {
    const f = vi.fn(async () => new Response("err", { status: 500 }));
    const c = new RuzClient({ fetchImpl: f as unknown as typeof fetch });
    await expect(c.getEntity(1)).rejects.toThrow(/500/);
  });
});
