import { describe, it, expect } from "vitest";
import { RuzClient } from "../src/ruz-client.js";

// Manual: hits the real RÚZ API. Run with `npm run test:live`.
describe("RuzClient live", () => {
  const c = new RuzClient();

  it("finds ESET by ICO", async () => {
    const ids = await c.findEntityIdsByIco("31333532");
    expect(ids.length).toBeGreaterThan(0);
    const e = await c.getEntity(ids[0]);
    expect(e.nazovUJ).toMatch(/ESET/i);
  });

  it("downloads an attachment as bytes (confirms download path)", async () => {
    // Find a report with an attachment on SPV s.r.o. (structured Úč POD filer).
    const ids = await c.findEntityIdsByIco("36586536");
    const e = await c.getEntity(ids[0]);
    let found = null as null | number;
    for (const zid of (e.idUctovnychZavierok ?? [])) {
      const stmt = await c.getStatement(zid);
      for (const vid of (stmt.idUctovnychVykazov ?? [])) {
        const report = await c.getReport(vid);
        const att = (report.prilohy ?? [])[0];
        if (att) { found = att.id; break; }
      }
      if (found) break;
    }
    if (found === null) return; // no attachment on this entity — skip
    const { base64, contentType } = await c.downloadAttachment(found);
    expect(base64.length).toBeGreaterThan(0);
    expect(contentType).toMatch(/pdf|octet-stream/i);
  });
});
