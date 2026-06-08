import type { ReportTable, TemplateTable } from "./types.js";

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
