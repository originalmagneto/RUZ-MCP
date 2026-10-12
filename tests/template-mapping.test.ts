/**
 * Indicator mapping on templates other than Úč POD / Úč MÚJ, and the remaining
 * low-severity audit items (C6). All reports are captured from the RÚZ API
 * (tests/fixtures/api): Hlavné mesto SR Bratislava (Úč ROPO SFOV, Kons. UJ VS),
 * Slovensko.Digital (Úč NUJ), Sociálna poisťovňa (Úč SP).
 */
import { afterEach, describe, expect, it } from "vitest";
import { extractIndicators } from "../src/financials.js";
import { RuzClient } from "../src/ruz-client.js";
import type { Report, Template } from "../src/types.js";
import { fixtureFetch, fixtureMcp, loadApi } from "./helpers/fixture-api.js";

const indicators = (reportId: number) => {
  const report = loadApi<Report>(`uctovny-vykaz/${reportId}.json`);
  const template = loadApi<Template>(`sablona/${report.idSablony}.json`);
  return Object.fromEntries(extractIndicators(report, template).map((i) => [i.key, i])) as Record<string, any>;
};

let mcp: Awaited<ReturnType<typeof fixtureMcp>> | undefined;
afterEach(async () => {
  await mcp?.close();
  mcp = undefined;
});

describe("Úč ROPO SFOV (Bratislava 2024, templates 690 + 727)", () => {
  it("equity is r. 116 'Vlastné imanie', not r. 115 'VLASTNÉ IMANIE A ZÁVÄZKY' (total of pasíva)", () => {
    const eq = indicators(9543237).equity;
    expect(eq.value).toBeCloseTo(1259650034.44, 2);
    expect(eq.rows).toEqual([116]);
  });

  it("assets and liabilities are the total rows", () => {
    const i = indicators(9543237);
    expect(i.assets.value).toBeCloseTo(1760160811.34, 2);
    expect(i.liabilities.rows).toEqual([126]);
  });

  it("revenue = r. 66 výrobky + r. 67 služby + r. 68 tovar (= subtotal r. 65)", () => {
    const rev = indicators(9543238).revenue;
    expect(rev.value).toBeCloseTo(26755359.85, 2);
    expect(rev.rows).toEqual([66, 67, 68]);
  });

  it("profit is r. 138 'Výsledok hospodárenia po zdanení'", () => {
    const p = indicators(9543238).profit;
    expect(p.value).toBeCloseTo(19567307.12, 2);
    expect(p.rows).toEqual([138]);
  });
});

describe("Kons. UJ VS (Bratislava 2024 consolidated, templates 684 + 696)", () => {
  it("equity r. 119 and revenue r. 67 + 68 + 69", () => {
    expect(indicators(9809772).equity.value).toBeCloseTo(1403837572.54, 2);
    const rev = indicators(9809773).revenue;
    expect(rev.value).toBe(225320253.24); // whole cents, no float residue
    expect(rev.rows).toEqual([67, 68, 69]);
  });

  it("sums of amounts with cents stay on whole cents (2025: 242 394 569,66)", () => {
    expect(indicators(10389625).revenue.value).toBe(242394569.66);
  });
});

describe("Úč NUJ (Slovensko.Digital 2025, template 1180)", () => {
  it("assets 'MAJETOK SPOLU' and profit 'Výsledok hospodárenia po zdanení' are found", () => {
    const i = indicators(10060461);
    expect(i.assets.value).toBe(120360);
    expect(i.profit.value).toBe(3443);
    expect(i.leverage).toBeUndefined(); // derived later in assembleYear
  });

  it("revenue sums výrobky, služby and tovar; empty rows add nothing", () => {
    const rev = indicators(10060461).revenue;
    expect(rev.value).toBe(3600);
    expect(rev.rows).toEqual([40]);
  });
});

describe("Úč SP (Sociálna poisťovňa 2024, templates 1141 + 1142)", () => {
  it("liabilities are unavailable — the template has no total row, r. 80 is 'Záväzky z nájmu'", () => {
    const l = indicators(9667719).liabilities;
    expect(l.available).toBe(false);
    expect(l.value).toBeNull();
  });

  it("assets 'MAJETOK spolu', profit r. 63 and revenue r. 37 + 38 + 39", () => {
    const i = { ...indicators(9667719), ...indicators(9667720) };
    expect(i.assets.value).toBeCloseTo(1627137756.5, 2);
    expect(i.profit.value).toBeCloseTo(-121482.27, 2);
    expect(i.revenue.rows).toEqual([37, 38, 39]);
  });
});

describe("C6 — an empty row is reported, not turned into zero", () => {
  it("Úč MÚJ with both revenue rows empty (s. r. o. v likvidácii, 2026-01–08): unavailable, with the reason", () => {
    const rev = indicators(10429793).revenue;
    expect(rev.available).toBe(false);
    expect(rev.value).toBeNull();
    expect(rev.note).toMatch(/r\. 2, r\. 3 je vo výkaze prázdny/);
  });
});

describe("C6 — ruz_get_report keeps every data column", () => {
  it("súvaha aktíva (699): brutto and korekcia next to netto", async () => {
    mcp = await fixtureMcp();
    const out = await mcp.call("ruz_get_report", { reportId: 10320048 });
    const r1 = out.tabulky.find((t: any) => t.nazov === "Strana aktív").riadky.find((r: any) => r.cisloRiadku === 1);
    expect(r1).toMatchObject({ bezne: 126626420, predchadzajuce: 98039110, brutto: 143844758, korekcia: 17218338 });
  });

  it("výnosy with activity split (727): hlavná and podnikateľská činnosť next to spolu", async () => {
    mcp = await fixtureMcp();
    const out = await mcp.call("ruz_get_report", { reportId: 9543238 });
    const r67 = out.tabulky.find((t: any) => t.nazov === "Výnosy").riadky.find((r: any) => r.cisloRiadku === 67);
    expect(r67).toMatchObject({
      bezne: 26755091.85,
      predchadzajuce: 14229822.17,
      hlavnaCinnost: 26635249.75,
      podnikatelskaCinnost: 119842.1,
    });
  });
});

describe("C6 — ruz_download_attachment", () => {
  it("an outage page served with HTTP 200 is reported as unavailability, not saved as a PDF", async () => {
    const f = (async () =>
      new Response("<!DOCTYPE html><html>Odstávka</html>", {
        status: 200,
        headers: { "content-type": "text/html;charset=UTF-8" },
      })) as unknown as typeof fetch;
    await expect(new RuzClient({ fetchImpl: f }).downloadAttachment(12823648)).rejects.toThrow(/nedostupný/);
  });

  it("the remote (HTTP) server refuses savePath instead of writing to its own disk", async () => {
    const pdf = (async (input: string | URL) =>
      input.toString().includes("/attachment/")
        ? new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200, headers: { "content-type": "application/pdf" } })
        : fixtureFetch()(input)) as typeof fetch;
    mcp = await fixtureMcp(pdf, { allowSavePath: false });
    await expect(mcp.call("ruz_download_attachment", { attachmentId: 1, savePath: "/tmp/x.pdf" })).rejects.toThrow(
      /savePath/,
    );
    const out = await mcp.call("ruz_download_attachment", { attachmentId: 1 });
    expect(out.base64).toBe("JVBERg==");
  });
});
