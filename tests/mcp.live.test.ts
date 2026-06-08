import { describe, it, expect } from "vitest";
import { RuzClient } from "../src/ruz-client.js";
import { assembleYear } from "../src/financials.js";
import type { ReportWithTemplate } from "../src/financials.js";

// Exercises the financial-profile chain against the live API.
describe("financial profile live", () => {
  it("builds a multi-year profile for a structured Úč POD company (SPV s.r.o.)", async () => {
    const client = new RuzClient();
    const ids = await client.findEntityIdsByIco("36586536");
    expect(ids.length).toBeGreaterThan(0);
    const e = await client.getEntity(ids[0]);
    const stmts = await Promise.all(
      (e.idUctovnychZavierok ?? []).slice(0, 3).map((s) => client.getStatement(s)),
    );
    const structured = stmts.filter((s) => (s.idUctovnychVykazov ?? []).length > 0);
    expect(structured.length).toBeGreaterThan(0);

    // Assemble one year end-to-end and confirm at least one indicator resolves.
    const stmt = structured[0];
    const rwts: ReportWithTemplate[] = [];
    for (const rid of (stmt.idUctovnychVykazov ?? [])) {
      const report = await client.getReport(rid);
      const template = report.idSablony ? await client.getTemplate(report.idSablony) : { id: 0 };
      rwts.push({ report, template });
    }
    const year = assembleYear(stmt, rwts);
    expect(year.indicators.some((i) => i.available)).toBe(true);
  });
});
