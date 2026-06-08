import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildRowIndex, cellValue, currentColumn, extractIndicators } from "../src/financials.js";
import type { Report, Template } from "../src/types.js";

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
});

describe("indicator extraction", () => {
  it("extracts súvaha indicators (assets, equity, liabilities)", () => {
    const inds = extractIndicators(suvahaReport, suvahaTemplate);
    const byKey = Object.fromEntries(inds.map((i) => [i.key, i]));
    expect(byKey.assets.available).toBe(true);
    expect(byKey.assets.value).toBeGreaterThan(0);
    expect(byKey.equity.available).toBe(true);
    expect(byKey.liabilities.available).toBe(true);
  });

  it("extracts výsledovka indicators (revenue, profit)", () => {
    const inds = extractIndicators(vzasReport, vzasTemplate);
    const byKey = Object.fromEntries(inds.map((i) => [i.key, i]));
    expect(byKey.revenue.available).toBe(true);
    expect(typeof byKey.revenue.value).toBe("number");
    expect(byKey.profit.available).toBe(true);
  });

  it("marks indicators unavailable for an empty obsah", () => {
    const empty: Report = { id: 1, obsah: {} };
    const inds = extractIndicators(empty, suvahaTemplate);
    expect(inds.every((i) => !i.available)).toBe(true);
  });
});
