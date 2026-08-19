import { describe, it, expect } from "vitest";
import { assembleYear, emptyIndicators, INDICATOR_KEYS } from "../src/financials.js";
import { parseRuzJson, RuzUnavailableError } from "../src/ruz-client.js";

const stmt = { obdobieOd: "2025-01", obdobieDo: "2025-12", konsolidovana: false } as never;

const EXPECTED = ["revenue", "profit", "equity", "assets", "liabilities", "leverage"];

describe("indicator shape is independent of the template", () => {
  // ESET (IFRS filer) came back with `leverage` alone while a small Úč MÚJ filer
  // returned six keys. A caller doing indicators.find(i => i.key === "revenue")
  // then gets undefined instead of { available: false } — "no such concept"
  // rather than "not published in this filing".
  it("returns all six keys for a statement with no usable reports", () => {
    const year = assembleYear(stmt, []);
    expect(year.indicators.map((i) => i.key)).toEqual(EXPECTED);
    expect(year.indicators.every((i) => i.available === false)).toBe(true);
    expect(year.indicators.every((i) => i.value === null)).toBe(true);
  });

  it("marks unavailable rather than omitting", () => {
    const year = assembleYear(stmt, []);
    const revenue = year.indicators.find((i) => i.key === "revenue");
    expect(revenue).toBeDefined();
    expect(revenue!.available).toBe(false);
  });

  it("keeps the key list and the placeholder set in step", () => {
    expect(emptyIndicators().map((i) => i.key)).toEqual(INDICATOR_KEYS.map((k) => k.key));
    expect(emptyIndicators().map((i) => i.key)).toEqual(EXPECTED);
  });

  it("flags the missing structured data on the year, not by dropping keys", () => {
    const year = assembleYear(stmt, []);
    expect(year.structuredDataAvailable).toBe(false);
    expect(year.attachmentHint).toBeTruthy();
  });
});

describe("parseRuzJson", () => {
  // registeruz.sk serves its outage page as HTML with HTTP 200, so res.ok is
  // true and JSON.parse produced `Unexpected token '<', "<!DOCTYPE "...` —
  // which reads like a bug here rather than a register that is down.
  it("recognises the outage page by its body", () => {
    expect(() => parseRuzJson('<!DOCTYPE html><html>...', "/uctovne-jednotky", null))
      .toThrow(RuzUnavailableError);
  });

  it("recognises it by content-type even without a leading angle bracket", () => {
    expect(() => parseRuzJson("  chyba ", "/x", "text/html; charset=utf-8"))
      .toThrow(RuzUnavailableError);
  });

  it("says the register is unavailable, not that JSON is broken", () => {
    try {
      parseRuzJson("<!DOCTYPE html>", "/uctovne-jednotky", null);
      throw new Error("malo hodiť");
    } catch (e) {
      expect((e as Error).message).toMatch(/nedostupný/i);
      expect((e as Error).message).not.toMatch(/Unexpected token/i);
    }
  });

  it("still parses real JSON", () => {
    expect(parseRuzJson<{ id: number[] }>('{"id":[1,2]}', "/x", "application/json").id).toEqual([1, 2]);
  });

  it("reports malformed JSON distinctly from an outage", () => {
    expect(() => parseRuzJson("{nie json", "/x", "application/json")).toThrow(/nie je platný JSON/);
    expect(() => parseRuzJson("{nie json", "/x", "application/json")).not.toThrow(RuzUnavailableError);
  });
});
