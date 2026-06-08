import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildRowIndex, cellValue, currentColumn, priorColumn, extractIndicators, assembleYear } from "../src/financials.js";
import type { Report, Template, Statement } from "../src/types.js";

const dir = dirname(fileURLToPath(import.meta.url));
const load = (f: string) => JSON.parse(readFileSync(join(dir, "fixtures", f), "utf8"));

const suvahaReport = load("vykaz-suvaha-pod.json") as Report;
const suvahaTemplate = load("sablona-suvaha-pod.json") as Template;

const vzasReport = load("vykaz-vzas-pod.json") as Report;
const vzasTemplate = load("sablona-vzas-pod.json") as Template;

describe("cell mapping", () => {
  it("resolves the current-period data column for a súvaha table", () => {
    const table = suvahaTemplate.tabulky![0];
    // Súvaha Úč POD data columns: [Brutto, Korekcia, Netto(current), Netto(prior)]
    expect(currentColumn(table)).toBe(2);
  });

  it("reads SPOLU MAJETOK (row 1) current netto value", () => {
    const idx = buildRowIndex(suvahaTemplate.tabulky![0]);
    const row = idx.byCisloRiadku.get(1)!;
    expect(row).toBeDefined();
    const v = cellValue(
      suvahaReport.obsah!.tabulky![0],
      suvahaTemplate.tabulky![0],
      row.position,
      currentColumn(suvahaTemplate.tabulky![0]),
    );
    expect(typeof v).toBe("number");
    expect(v).toBeGreaterThan(0);
  });

  it("matches a row by label regex", () => {
    const idx = buildRowIndex(suvahaTemplate.tabulky![0]);
    const row = idx.matchByLabel(/^SPOLU MAJETOK/i);
    expect(row?.cisloRiadku).toBe(1);
  });

  it("resolves prior-period column", () => {
    expect(priorColumn(suvahaTemplate.tabulky![0])).toBe(3); // 4-col aktíva
    expect(priorColumn(vzasTemplate.tabulky![0])).toBe(1);   // 2-col výsledovka
    expect(priorColumn({ pocetDatovychStlpcov: 1 })).toBeNull();
  });
});

describe("indicator extraction", () => {
  it("extracts súvaha indicators (assets, equity, liabilities)", () => {
    const inds = extractIndicators(suvahaReport, suvahaTemplate);
    const byKey = Object.fromEntries(inds.map((i) => [i.key, i]));
    expect(byKey.assets.value).toBe(500466);
    expect(byKey.equity.value).toBe(289336);
    expect(byKey.liabilities.value).toBe(211130);
    // Balance-sheet identity: equity + liabilities = assets
    expect(byKey.equity.value! + byKey.liabilities.value!).toBe(byKey.assets.value);
  });

  it("extracts výsledovka indicators (revenue, profit)", () => {
    const inds = extractIndicators(vzasReport, vzasTemplate);
    const byKey = Object.fromEntries(inds.map((i) => [i.key, i]));
    expect(byKey.revenue.value).toBe(13500);
    expect(byKey.profit.value).toBe(6756);
  });

  it("marks indicators unavailable for an empty obsah", () => {
    const empty: Report = { id: 1, obsah: {} };
    const inds = extractIndicators(empty, suvahaTemplate);
    expect(inds.every((i) => !i.available)).toBe(true);
  });
});

describe("year assembly", () => {
  const stmt: Statement = {
    id: 99, obdobieOd: "2021-01", obdobieDo: "2021-12",
    typ: "Riadna", konsolidovana: false,
  };

  it("assembles a year with leverage derived from súvaha", () => {
    const year = assembleYear(stmt, [
      { report: suvahaReport, template: suvahaTemplate },
      { report: vzasReport, template: vzasTemplate },
    ]);
    expect(year.year).toBe(2021);
    expect(year.structuredDataAvailable).toBe(true);
    const lev = year.indicators.find((i) => i.key === "leverage")!;
    expect(lev.available).toBe(true);
    expect(lev.value).toBeCloseTo(0.4219, 4); // 211130 / 500466
  });

  it("flags structured data unavailable when all reports have empty obsah", () => {
    const year = assembleYear(stmt, [
      { report: { id: 1, obsah: {} }, template: suvahaTemplate },
    ]);
    expect(year.structuredDataAvailable).toBe(false);
    expect(year.attachmentHint).toMatch(/ruz_download_attachment/);
  });
});
