/**
 * Regression tests for the 2026-10-09 audit (findings C1–C5), run against
 * responses captured from the live RÚZ API (tests/fixtures/api).
 */
import { afterEach, describe, expect, it } from "vitest";
import { assembleYear, extractIndicators, attachmentHintFor } from "../src/financials.js";
import { classifyEntityStav, selectPrimaryStatement } from "../src/profile.js";
import { RuzClient } from "../src/ruz-client.js";
import type { Report, Statement, Template } from "../src/types.js";
import { fixtureFetch, fixtureMcp, loadApi } from "./helpers/fixture-api.js";

const tpl = (id: number) => loadApi<Template>(`sablona/${id}.json`);
const rep = (id: number) => loadApi<Report>(`uctovny-vykaz/${id}.json`);
const stmt = (id: number) => loadApi<Statement>(`uctovna-zavierka/${id}.json`);
const byKey = (inds: { key: string }[]) => Object.fromEntries(inds.map((i) => [i.key, i])) as Record<string, any>;

let mcp: Awaited<ReturnType<typeof fixtureMcp>> | undefined;
afterEach(async () => {
  await mcp?.close();
  mcp = undefined;
});

describe("C1 — revenue on Úč POD 2014+ (template 699) includes products and services", () => {
  it("Websupport 2025: services-only revenue (r.05) is reported, not missing", () => {
    const r = byKey(extractIndicators(rep(10323268), tpl(699))).revenue;
    expect(r.available).toBe(true);
    expect(r.value).toBe(13148139); // r.05 = r.01 čistý obrat in the register
    expect(r.rows).toEqual([5]);
  });

  it("Alza 2025: goods (r.03) + services (r.05), not goods alone", () => {
    const r = byKey(extractIndicators(rep(10320048), tpl(699))).revenue;
    expect(r.value).toBe(560556309 + 56900962);
    expect(r.rows).toEqual([3, 5]);
  });

  it("template 22 (Úč POD 2-01): the combined products+services row is counted once", () => {
    // Websupport 2013, filing 2605887: r.01 empty, r.05 = 1 765 101.
    const r = byKey(extractIndicators(rep(4927541), tpl(22))).revenue;
    expect(r.value).toBe(1765101);
    expect(r.rows).toEqual([5]);
  });

  it("negative results pass through with their sign", () => {
    expect(byKey(extractIndicators(rep(4927541), tpl(22))).profit.value).toBe(-114783);
  });

  it("ruz_get_report reads current and prior period from the right columns (699)", async () => {
    mcp = await fixtureMcp();
    const out = await mcp.call("ruz_get_report", { reportId: 10320048 });
    const vzas = out.tabulky.find((t: any) => t.nazov === "Výkaz ziskov a strát");
    const r3 = vzas.riadky.find((r: any) => r.cisloRiadku === 3);
    expect(r3.bezne).toBe(560556309);
    expect(r3.predchadzajuce).toBe(489984554);
  });
});

describe("C2 — entity resolution skips deleted records and does not mislabel them", () => {
  it("classifies the two documented stav values distinctly", () => {
    expect(classifyEntityStav(undefined)).toBe("live");
    expect(classifyEntityStav("ZMAZANÉ")).toBe("deleted");
    expect(classifyEntityStav("Neverejná")).toBe("nonpublic");
  });

  it("IČO 99999999: deleted first id is skipped, live units are offered as candidates", async () => {
    mcp = await fixtureMcp();
    const out = await mcp.call("ruz_financial_profile", { ico: "99999999" });
    expect(out.note ?? "").not.toMatch(/Neverejná jednotka/);
    expect(out.ambiguous).toBe(true);
    expect(out.candidates.map((c: any) => c.entityId).sort()).toEqual([2258763, 2401446]);
    expect(out.deletedEntityIds).toEqual([2139453]);
    expect(out.note).toMatch(/2 živé účtovné jednotky/);
  });

  it("a candidate can then be profiled by entityId", async () => {
    mcp = await fixtureMcp();
    const out = await mcp.call("ruz_financial_profile", { ico: "99999999", entityId: 2258763 });
    expect(out.found).toBe(true);
    expect(out.entity.entityId).toBe(2258763);
    expect(out.years.map((y: any) => y.year)).toEqual([2025, 2024, 2023]);
    // Its reports are filed with pristupnostDat "Neverejné": no figures, no PDFs.
    expect(out.years[0].attachmentHint).toMatch(/neverejnej časti/);
    expect(out.years[0].attachmentHint).not.toMatch(/ruz_download_attachment/);
  });

  it("an entityId belonging to another IČO is refused, not profiled under the given IČO", async () => {
    mcp = await fixtureMcp();
    const out = await mcp.call("ruz_financial_profile", { ico: "36421928", entityId: 280766 });
    expect(out.found).toBe(false);
    expect(out.note).toMatch(/36562939/);
  });

  it("ruz_list_statements does not return an empty list for the deleted record", async () => {
    mcp = await fixtureMcp();
    const out = await mcp.call("ruz_list_statements", { ico: "99999999" });
    expect(out.ambiguous).toBe(true);
    expect(out.candidates).toHaveLength(2);
  });

  it("an IČO with only a deleted record says so instead of 'Neverejná jednotka'", async () => {
    const base = fixtureFetch();
    const onlyDeleted = (async (input: string | URL) =>
      input.toString().includes("/uctovne-jednotky?")
        ? new Response(JSON.stringify({ id: [2139453], existujeDalsieId: false }), { status: 200 })
        : base(input)) as typeof fetch;
    mcp = await fixtureMcp(onlyDeleted);
    const out = await mcp.call("ruz_financial_profile", { ico: "99999999" });
    expect(out.stav).toBe("ZMAZANÉ");
    expect(out.note).toMatch(/zmazan/i);
    expect(out.note).not.toMatch(/Neverejná jednotka/);
  });

  it("follows existujeDalsieId instead of stopping at the first page", async () => {
    const seen: string[] = [];
    const f = (async (input: string | URL) => {
      const u = new URL(input.toString());
      seen.push(u.search);
      const after = u.searchParams.get("pokracovat-za-id");
      const body = after === "0" ? { id: [1, 2], existujeDalsieId: true } : { id: [3], existujeDalsieId: false };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const ids = await new RuzClient({ fetchImpl: f }).findEntityIdsByIco("99999999");
    expect(ids).toEqual([1, 2, 3]);
    expect(seen[1]).toContain("pokracovat-za-id=2");
  });
});

describe("C3 — one row per period, with the statement it came from", () => {
  it("VW Slovakia years:2 returns 2025 and 2024 once each, listing the other filings", async () => {
    mcp = await fixtureMcp();
    const out = await mcp.call("ruz_financial_profile", { ico: "35757442", years: 2 });
    expect(out.years.map((y: any) => y.year)).toEqual([2025, 2024]);
    const y25 = out.years[0];
    const all25 = [6965375, 6961057, 6961084, 6964194];
    expect(all25).toContain(y25.statementId);
    expect(y25.otherStatements.map((s: any) => s.statementId).sort()).toEqual(
      all25.filter((id) => id !== y25.statementId).sort(),
    );
    expect(y25.note).toMatch(/4 závier/);
  });

  it("Websupport 2013: two 'Riadna' filings with different numbers — the later one is primary, the other is listed", () => {
    const first = assembleYear(stmt(2109999), [
      { report: rep(4152633), template: tpl(21) },
      { report: rep(4152632), template: tpl(22) },
      { report: rep(4152631), template: tpl(395) },
    ]);
    const second = assembleYear(stmt(2605887), [
      { report: rep(4927520), template: tpl(21) },
      { report: rep(4927541), template: tpl(22) },
      { report: rep(4927519), template: tpl(395) },
    ]);
    const year = selectPrimaryStatement([first, second]);
    expect(year.statementId).toBe(2605887);
    expect(year.datumPodania).toBe("2015-07-08");
    expect(byKey(year.indicators).equity.value).toBe(19925);
    expect(year.otherStatements).toEqual([
      expect.objectContaining({ statementId: 2109999, structuredDataAvailable: true, datumPodania: "2014-03-28" }),
    ]);
    expect(year.note).toMatch(/2 závier/);
  });
});

describe("C4 — templateName comes from the report the numbers came from", () => {
  it("Alza 2024: 'Úč POD', not the auditor's report filed first", () => {
    const year = assembleYear(stmt(6530333), [
      { report: rep(9752732), template: tpl(700) },
      { report: rep(9752733), template: tpl(699) },
      { report: rep(9830308), template: tpl(1171) },
    ]);
    expect(year.templateName).toBe("Úč POD");
    expect(year.templateNames).toEqual(["Správa audítora", "Úč POD", "Oznámenie o dátume schválenia účtovnej závierky"]);
    expect(year.attachmentHint).toBeUndefined();
  });

  it("VW 2025 filing with VÚ POD + IFRS + auditor's report: the hint names IFRS", () => {
    const year = assembleYear(stmt(6964194), [
      { report: rep(10264616), template: tpl(5183) },
      { report: rep(10264615), template: tpl(709) },
      { report: rep(10268627), template: tpl(742) },
    ]);
    expect(year.structuredDataAvailable).toBe(false);
    expect(year.templateName).toBe("IFRS účtovná závierka");
    expect(year.attachmentHint).toMatch(/IFRS/);
    expect(attachmentHintFor(year.templateNames)).toMatch(/IFRS/);
  });

  it("an IFRS-only profile says plainly that no indicator is available", async () => {
    mcp = await fixtureMcp();
    const out = await mcp.call("ruz_financial_profile", { ico: "35757442", years: 1 });
    expect(out.years[0].indicators.every((i: any) => i.available === false)).toBe(true);
    expect(out.note).toMatch(/IFRS/);
    expect(out.note).toMatch(/available: false/);
  });
});

describe("C5 — codelist values are decoded", () => {
  it("Alza: velkost '25' means 500-999 employees, pravnaForma '112' is an s. r. o.", async () => {
    mcp = await fixtureMcp();
    const out = await mcp.call("ruz_financial_profile", { ico: "36562939", years: 1 });
    expect(out.entity.velkostKod).toBe("25");
    expect(out.entity.velkost).toBe("500-999 zamestnancov");
    expect(out.entity.pravnaFormaKod).toBe("112");
    expect(out.entity.pravnaForma).toBe("Spol. s r. o.");
  });

  it("a codelist outage keeps the code and says the label is unknown", async () => {
    const base = fixtureFetch();
    const noCodelists = (async (input: string | URL) =>
      /velkosti-organizacie|pravne-formy/.test(input.toString())
        ? new Response("err", { status: 503 })
        : base(input)) as typeof fetch;
    mcp = await fixtureMcp(noCodelists);
    const out = await mcp.call("ruz_financial_profile", { ico: "36562939", years: 1 });
    expect(out.entity.velkostKod).toBe("25");
    expect(out.entity.velkost).toBeNull();
    expect(out.entity.codelistNote).toMatch(/číselník/i);
    expect(out.years).toHaveLength(1);
  });
});
