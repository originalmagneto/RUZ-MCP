import type { CodelistResponse, Entity, Statement, YearFinancials } from "./types.js";

// ---------------------------------------------------------------------------
// Entity status
// ---------------------------------------------------------------------------

export type EntityKind = "live" | "deleted" | "nonpublic" | "other";

/**
 * RÚZ API documents two values of `stav` on an entity detail: "ZMAZANÉ" for a
 * deleted record (only id, datumPoslednejUpravy and stav remain) and, since
 * API 2.5, "Neverejná" for a unit moved to the non-public part of the register
 * (§ 23 ods. 8 zákona č. 431/2002 Z. z.). A live record carries no `stav`.
 *
 * Every `stav` used to be reported as "Neverejná jednotka", so an IČO whose
 * first id was a deleted record hid the live units filed under it.
 */
export function classifyEntityStav(stav: string | undefined): EntityKind {
  if (!stav) return "live";
  const s = stav.toUpperCase();
  if (s.startsWith("ZMAZAN")) return "deleted";
  if (s.includes("NEVEREJN")) return "nonpublic";
  return "other";
}

export function entityStavNote(kind: EntityKind, stav: string | undefined): string {
  if (kind === "deleted") {
    return "Záznam účtovnej jednotky bol v RÚZ zmazaný; register k nemu nevracia žiadne údaje ani závierky.";
  }
  if (kind === "nonpublic") {
    return (
      "Neverejná jednotka — RÚZ ju presunul do neverejnej časti (§ 23 ods. 8 zákona č. 431/2002 Z. z.); " +
      "závierky nie sú verejne dostupné."
    );
  }
  return `RÚZ vrátil pre jednotku stav „${stav}“ bez ďalších údajov.`;
}

/** Short description of a live unit, for choosing between several under one IČO. */
export function entityCandidate(e: Entity) {
  return {
    entityId: e.id,
    nazov: e.nazovUJ,
    ico: e.ico,
    dic: e.dic,
    mesto: e.mesto,
    datumZalozenia: e.datumZalozenia,
    datumZrusenia: e.datumZrusenia,
    pocetZavierok: e.idUctovnychZavierok?.length ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Statements per period
// ---------------------------------------------------------------------------

const periodKey = (s: Statement) => `${s.obdobieOd ?? ""}|${s.obdobieDo ?? ""}`;

/**
 * Group statements by accounting period, newest period first.
 *
 * RÚZ often holds several statements for one period: VW Slovakia files four
 * per year (IFRS, VÚ POD, auditor's report…), Websupport filed 2013 twice as
 * "Riadna" with different figures. Slicing the flat list made `years: 5`
 * return 2025 four times.
 */
export function groupStatementsByPeriod(statements: Statement[]): Statement[][] {
  const groups = new Map<string, Statement[]>();
  for (const s of statements) {
    if (!s.obdobieDo) continue;
    const key = periodKey(s);
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return [...groups.values()].sort((a, b) => {
    const byEnd = (b[0].obdobieDo ?? "").localeCompare(a[0].obdobieDo ?? "");
    return byEnd !== 0 ? byEnd : (b[0].obdobieOd ?? "").localeCompare(a[0].obdobieOd ?? "");
  });
}

const zavierky = (n: number) => (n >= 2 && n <= 4 ? "závierky" : "závierok");

/**
 * Pick the statement a period's indicators are reported from, and list the
 * rest. Rule: a statement with structured data first, then the latest
 * datumPodania, then the higher id. The rule is stated in the output — the
 * register does not say which filing supersedes which.
 */
export function selectPrimaryStatement(years: YearFinancials[]): YearFinancials {
  const ordered = [...years].sort(
    (a, b) =>
      Number(b.structuredDataAvailable) - Number(a.structuredDataAvailable) ||
      (b.datumPodania ?? "").localeCompare(a.datumPodania ?? "") ||
      (b.statementId ?? 0) - (a.statementId ?? 0),
  );
  const [primary, ...others] = ordered;
  if (others.length === 0) return primary;

  const n = ordered.length;
  const structuredCount = ordered.filter((y) => y.structuredDataAvailable).length;
  let note =
    `Za obdobie ${primary.periodOd}–${primary.periodDo} sú v RÚZ ${n} ${zavierky(n)}. ` +
    `Ukazovatele sú zo závierky ${primary.statementId} (pravidlo: najprv závierka so štruktúrovanými ` +
    `dátami, potom najneskôr podaná). Ostatné sú v otherStatements.`;
  if (structuredCount > 1) {
    note +=
      ` Štruktúrované dáta má ${structuredCount} z nich a ich čísla sa môžu líšiť — ` +
      "porovnaj cez ruz_get_statement a ruz_get_report.";
  } else if (structuredCount === 0) {
    note += " Žiadna z nich nemá v RÚZ štruktúrované dáta.";
  }
  return {
    ...primary,
    otherStatements: others.map((y) => ({
      statementId: y.statementId!,
      typ: y.typ,
      datumPodania: y.datumPodania,
      datumSchvalenia: y.datumSchvalenia,
      structuredDataAvailable: y.structuredDataAvailable,
      templateNames: y.templateNames ?? [],
    })),
    note,
  };
}

// ---------------------------------------------------------------------------
// Codelists
// ---------------------------------------------------------------------------

/** Slovak label for a codelist code, or null when the code is not listed. */
export function decodeCode(codelist: CodelistResponse | null, code: string | undefined): string | null {
  if (!codelist || !code) return null;
  return codelist.klasifikacie?.find((k) => k.kod === code)?.nazov?.sk ?? null;
}
