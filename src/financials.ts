import type { ReportTable, TemplateTable, Report, Template, IndicatorValue } from "./types.js";

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
  {
    key: "revenue",
    label: "Tržby",
    table: "vzas",
    match: [
      /^Tržby z predaja tovaru/i,
      /^Tržby z predaja vlastných výrobkov a služieb/i,
    ],
  },
  {
    key: "profit",
    label: "Výsledok hospodárenia za účtovné obdobie po zdanení",
    table: "vzas",
    match: [/^Výsledok hospodárenia za účtovné obdobie po zdanení/i],
  },
  {
    key: "equity",
    label: "Vlastné imanie",
    table: "suvaha",
    match: [/^Vlastné imanie\b/i],
  },
  {
    key: "assets",
    label: "Aktíva spolu",
    table: "suvaha",
    match: [/^SPOLU MAJETOK/i, /^Spolu majetok/i],
  },
  {
    key: "liabilities",
    label: "Záväzky",
    table: "suvaha",
    match: [/^Záväzky\b/i],
  },
  // "leverage" is derived after extraction (liabilities / assets); see assembleYear.
];

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
    let firstRow: number | null = null;
    if (hasData) {
      for (const p of paired) {
        if (p.kind !== def.table || !p.report) continue;
        const idx = buildRowIndex(p.template);
        const col = currentColumn(p.template);
        for (const re of def.match) {
          const row = idx.matchByLabel(re);
          if (!row) continue;
          const v = cellValue(p.report, p.template, row.position, col);
          if (v !== null) {
            sum = (sum ?? 0) + v;
            if (firstRow === null) firstRow = row.cisloRiadku;
          }
        }
      }
    }
    out.push({
      key: def.key,
      label: def.label,
      value: hasData ? sum : null,
      cisloRiadku: firstRow,
      available: hasData && sum !== null,
    });
  }
  return out;
}
