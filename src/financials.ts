import type { ReportTable, TemplateTable, Report, Template, IndicatorValue, Statement, YearFinancials } from "./types.js";

export interface IndexedRow {
  position: number;          // 0-based index within riadky
  cisloRiadku: number;
  label: string;
}

export interface RowIndex {
  rows: IndexedRow[];
  byCisloRiadku: Map<number, IndexedRow>;
  matchByLabel(re: RegExp): IndexedRow | undefined;
}

/** Build an index of a template table's statutory rows. */
export function buildRowIndex(table: TemplateTable): RowIndex {
  const rows: IndexedRow[] = (table.riadky ?? []).map((r, position) => ({
    position,
    cisloRiadku: r.cisloRiadku,
    label: r.text?.sk ?? "",
  }));
  const byCisloRiadku = new Map<number, IndexedRow>();
  for (const r of rows) byCisloRiadku.set(r.cisloRiadku, r);
  return {
    rows,
    byCisloRiadku,
    matchByLabel: (re) => rows.find((r) => re.test(r.label)),
  };
}

/**
 * Index of the current-period data column.
 * Súvaha Úč POD has 4 data columns [Brutto, Korekcia, Netto(current), Netto(prior)]
 * → current netto is column 2. Výkaz ziskov a strát has 2 columns
 * [current, prior] → current is column 0.
 */
export function currentColumn(table: TemplateTable): number {
  const cols = table.pocetDatovychStlpcov ?? 1;
  return cols >= 4 ? 2 : 0;
}

/** Index of the prior-period data column, or null if not present. */
export function priorColumn(table: TemplateTable): number | null {
  const cols = table.pocetDatovychStlpcov ?? 1;
  if (cols >= 4) return 3;
  if (cols >= 2) return 1;
  return null;
}

/** Read a numeric cell via row-major layout: data[row * dataCols + col]. */
export function cellValue(
  reportTable: ReportTable,
  templateTable: TemplateTable,
  rowPosition: number,
  col: number,
): number | null {
  const cols = templateTable.pocetDatovychStlpcov ?? 1;
  const data = reportTable.data ?? [];
  const raw = data[rowPosition * cols + col];
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Indicator dictionary + per-report extraction
// ---------------------------------------------------------------------------

type TableKind = "suvaha" | "vzas";

interface IndicatorDef {
  key: string;
  label: string;
  table: TableKind;
  /** One or more label regexes; matched rows are summed. */
  match: RegExp[];
}

/** Six DD indicators. Label regexes target statutory Úč POD wording. */
const INDICATORS: IndicatorDef[] = [
  // Tržby = goods + own products + services. Úč POD 2-01 (id 22, to 2013) and
  // Úč MÚJ (id 687) carry products and services on one row ("vlastných výrobkov
  // a služieb"); Úč POD from 2014 (id 699) splits them into r.04 "vlastných
  // výrobkov" and r.05 "služieb". Matching only the combined wording summed
  // r.03 alone on 699, so a services company reported no revenue at all.
  // A row matched by two patterns is counted once (see extractIndicators).
  {
    key: "revenue",
    label: "Tržby",
    table: "vzas",
    match: [
      /^Tržby z predaja tovaru/i,
      /^Tržby z predaja vlastných výrobkov/i,
      /^Tržby z predaja služieb/i,
    ],
  },
  {
    key: "profit",
    label: "Výsledok hospodárenia za účtovné obdobie po zdanení",
    table: "vzas",
    match: [/^Výsledok hospodárenia za účtovné obdobie po zdanení/i],
  },
  // Assumes the "Vlastné imanie" total row precedes any sub-rows (true for Úč POD/Úč MÚJ);
  // matchByLabel returns the first match in row order.
  { key: "equity", label: "Vlastné imanie", table: "suvaha",
    match: [/^Vlastné imanie\b/i] },
  {
    key: "assets",
    label: "Aktíva spolu",
    table: "suvaha",
    match: [/^SPOLU MAJETOK/i],
  },
  {
    key: "liabilities",
    label: "Záväzky",
    table: "suvaha",
    match: [/^Záväzky\b/i],
  },
  // "leverage" is derived after extraction (liabilities / assets); see assembleYear.
];

/**
 * Every key a YearFinancials must carry, in order, including the derived one.
 *
 * extractIndicators only emits an indicator when the report actually contains a
 * table of the matching kind. An IFRS statement has neither súvaha nor
 * výsledovka, so it emitted nothing and the year came back with `leverage`
 * alone — one key where a small company returns six. A caller doing
 * `indicators.find(i => i.key === "revenue")` then got `undefined` instead of
 * `available: false`, which reads as "no such concept" rather than "not
 * published in this filing".
 */
export const INDICATOR_KEYS: ReadonlyArray<{ key: string; label: string }> = [
  ...INDICATORS.map((d) => ({ key: d.key, label: d.label })),
  { key: "leverage", label: "Zadlženosť (záväzky / aktíva)" },
];

/** Placeholder set: all keys present, nothing available yet. */
export function emptyIndicators(): IndicatorValue[] {
  return INDICATOR_KEYS.map(({ key, label }) => ({
    key,
    label,
    value: null,
    cisloRiadku: null,
    available: false,
  }));
}

/** Classify a template table as súvaha or výsledovka by its name. */
function classifyTable(name: string | undefined): TableKind | null {
  const n = (name ?? "").toLowerCase();
  if (n.includes("aktív") || n.includes("pasív") || n.includes("súvah")) return "suvaha";
  if (
    n.includes("výnos") ||
    n.includes("náklad") ||
    n.includes("ziskov") ||
    n.includes("výsledov")
  )
    return "vzas";
  return null;
}

export interface ReportWithTemplate {
  report: Report;
  template: Template;
}

/**
 * Determine which report this template represents and extract the indicators
 * whose `table` kind matches. Súvaha templates have multiple tables (aktíva,
 * pasíva); each indicator searches every table of its kind.
 */
export function extractIndicators(report: Report, template: Template): IndicatorValue[] {
  const tables = template.tabulky ?? [];
  const reportTables = report.obsah?.tabulky ?? [];
  const hasData = reportTables.length > 0;

  // Pair template tables with report tables by position.
  const paired = tables.map((t, i) => ({
    template: t,
    report: reportTables[i],
    kind: classifyTable(t.nazov?.sk),
  }));

  // What kinds of tables does this report carry?
  const reportKinds = new Set(paired.map((p) => p.kind).filter(Boolean));

  const out: IndicatorValue[] = [];
  for (const def of INDICATORS) {
    if (!reportKinds.has(def.table)) continue; // indicator belongs to a different report
    let sum: number | null = null;
    const rows: number[] = [];
    if (hasData) {
      for (const p of paired) {
        if (p.kind !== def.table || !p.report) continue;
        const idx = buildRowIndex(p.template);
        const col = currentColumn(p.template);
        const used = new Set<number>();
        for (const re of def.match) {
          const row = idx.matchByLabel(re);
          if (!row || used.has(row.position)) continue;
          used.add(row.position);
          const v = cellValue(p.report, p.template, row.position, col);
          if (v !== null) {
            sum = (sum ?? 0) + v;
            rows.push(row.cisloRiadku);
          }
        }
      }
    }
    out.push({
      key: def.key,
      label: def.label,
      value: hasData ? sum : null,
      cisloRiadku: rows[0] ?? null,
      rows,
      available: hasData && sum !== null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Year assembly + derived indicators
// ---------------------------------------------------------------------------

/**
 * Explain WHY the structured content is missing, using the template that was
 * actually filed.
 *
 * The old wording always blamed "IFRS/banka/oznámenie", which contradicted a
 * `templateName` of "Výkaz vybraných údajov VÚ POD 1-01" sitting two fields
 * above it.
 *
 * Measured against the register for ESET (IČO 31333532), statement 6941236:
 * all three reports carry `obsah.tabulky: []`, so the data genuinely is not
 * published. And template 5183 (VÚ POD 1-01) declares six tables named
 * "I.: Tab. č. 1" … with EVERY row label null — neither classifyTable nor the
 * label regexes have anything to match, so even a VÚ POD filing that did carry
 * cells could not be read without a per-template row-number map.
 */
export function attachmentHintFor(templateNames: string | string[] | undefined): string {
  const names = (Array.isArray(templateNames) ? templateNames : [templateNames ?? ""]).map((n) =>
    n.toLowerCase(),
  );
  const any = (pred: (n: string) => boolean) => names.some(pred);
  const base = "Použi ruz_list_attachments + ruz_download_attachment a čítaj PDF.";
  // A statement often bundles several reports (e.g. VÚ POD + IFRS + auditor's
  // report). The financial statement itself decides the reason, so IFRS wins.
  if (any(isIfrs)) {
    return (
      "IFRS závierka — RÚZ pre ňu nezverejňuje štruktúrovaný obsah, preto sú všetky ukazovatele " +
      `available: false (nie sú to nuly). ${base}`
    );
  }
  if (any(isVuPod)) {
    return (
      "Výkaz vybraných údajov (VÚ POD) nemá v RÚZ zverejnený štruktúrovaný obsah " +
      "a jeho riadky nie sú pomenované, takže ukazovatele z neho nemožno odvodiť. " + base
    );
  }
  if (names.length > 0 && names.every((n) => n !== "" && isAncillary(n))) {
    return `Ide o správu, nie o výkaz — štruktúrované dáta neobsahuje. ${base}`;
  }
  return `Štruktúrované dáta nie sú pre túto závierku v RÚZ dostupné. ${base}`;
}

const NON_PUBLIC_HINT =
  "Výkazy tejto závierky sú v neverejnej časti RÚZ (pristupnostDat: Neverejné) — register nezverejňuje " +
  "ani čísla, ani PDF prílohy.";

const isIfrs = (n: string) => n.includes("ifrs");
const isVuPod = (n: string) =>
  n.includes("vybraných údajov") || n.includes("vu pod") || n.includes("vú pod");
/** Reports that accompany a statement but carry no figures of their own. */
const isAncillary = (n: string) =>
  n.includes("audítor") || n.includes("auditor") || n.includes("správa") ||
  n.includes("oznámenie") || n.includes("poznámky");

/** Name the statement's main report when none of them carries figures. */
function mainTemplateName(names: string[]): string | undefined {
  const lower = (n: string) => n.toLowerCase();
  return (
    names.find((n) => isIfrs(lower(n))) ??
    names.find((n) => isVuPod(lower(n))) ??
    names.find((n) => !isAncillary(lower(n))) ??
    names[0]
  );
}

function yearFromPeriod(s: Statement): number {
  const p = s.obdobieDo ?? s.obdobieOd ?? "";
  const y = Number(p.slice(0, 4));
  // 0 is a defensive fallback for the (practically non-occurring) case of a statement with no period fields; RÚZ statements always carry `obdobieDo`.
  return Number.isFinite(y) ? y : 0;
}

/** Merge indicators from all reports of a statement and derive leverage. */
export function assembleYear(stmt: Statement, reports: ReportWithTemplate[]): YearFinancials {
  // Seed every key so the response shape never depends on the template.
  const all: IndicatorValue[] = emptyIndicators();
  let anyStructured = false;
  // Templates the figures were read from (2009–2013 filings split súvaha and
  // výsledovka into two reports). Taking the first report's template labelled
  // Alza's Úč POD figures as "Správa audítora".
  const sourceTemplates: string[] = [];
  const templateNames: string[] = [];
  for (const { report, template } of reports) {
    if ((report.obsah?.tabulky?.length ?? 0) > 0) anyStructured = true;
    if (template.nazov) templateNames.push(template.nazov);
    for (const ind of extractIndicators(report, template)) {
      // Keep the first available value per key; otherwise keep the placeholder.
      const existing = all.find((x) => x.key === ind.key);
      if (!existing) all.push(ind);
      else if (!existing.available && ind.available) {
        Object.assign(existing, ind);
        if (template.nazov && !sourceTemplates.includes(template.nazov)) sourceTemplates.push(template.nazov);
      }
    }
  }

  // RÚZ keeps some reports in its non-public part (pristupnostDat "Neverejné"):
  // neither figures nor attachments are published, so pointing at the PDF
  // would send the caller to an empty list.
  const allNonPublic =
    reports.length > 0 && reports.every(({ report }) => report.pristupnostDat === "Neverejné");

  // Derived: leverage = liabilities / assets.
  const liabilities = all.find((x) => x.key === "liabilities");
  const assets = all.find((x) => x.key === "assets");
  const leverageValue =
    liabilities?.available && assets?.available && assets.value
      ? Number((liabilities.value! / assets.value!).toFixed(4))
      : null;
  const leverage = all.find((x) => x.key === "leverage")!;
  leverage.value = leverageValue;
  leverage.available = leverageValue !== null;

  return {
    year: yearFromPeriod(stmt),
    periodOd: stmt.obdobieOd,
    periodDo: stmt.obdobieDo,
    statementId: stmt.id,
    typ: stmt.typ,
    datumPodania: stmt.datumPodania,
    datumSchvalenia: stmt.datumSchvalenia,
    consolidated: stmt.konsolidovana ?? false,
    templateName: sourceTemplates.length > 0 ? sourceTemplates.join(" + ") : mainTemplateName(templateNames),
    templateNames,
    structuredDataAvailable: anyStructured,
    attachmentHint: anyStructured
      ? undefined
      : allNonPublic
      ? NON_PUBLIC_HINT
      : attachmentHintFor(templateNames),
    indicators: all,
  };
}
