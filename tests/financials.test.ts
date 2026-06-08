import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildRowIndex, cellValue, currentColumn } from "../src/financials.js";
import type { Report, Template } from "../src/types.js";

const dir = dirname(fileURLToPath(import.meta.url));
const load = (f: string) => JSON.parse(readFileSync(join(dir, "fixtures", f), "utf8"));

const suvahaReport = load("vykaz-suvaha-pod.json") as Report;
const suvahaTemplate = load("sablona-suvaha-pod.json") as Template;

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
