// Raw API shapes (subset of fields we use) ---------------------------------

export interface EntityIdsResponse {
  id: number[];
  existujeDalsieId: boolean;
}

export interface Entity {
  id: number;
  stav?: string;                 // present (e.g. "NEVEREJNÁ") only on restricted records
  nazovUJ?: string;
  ico?: string;
  dic?: string;
  skNace?: string;
  pravnaForma?: string;
  velkostOrganizacie?: string;
  datumZalozenia?: string;
  ulica?: string;
  mesto?: string;
  psc?: string;
  sidlo?: string;
  konsolidovana?: boolean;
  zdrojDat?: string;
  idUctovnychZavierok?: number[];
  idVyrocnychSprav?: number[];
  datumPoslednejUpravy?: string;
}

export interface Statement {
  id: number;
  stav?: string;
  idUJ?: number;
  idUctovnychVykazov?: number[];
  obdobieOd?: string;            // "YYYY-MM"
  obdobieDo?: string;            // "YYYY-MM"
  datumZostaveniaK?: string;     // "YYYY-MM-DD"
  typ?: string;                  // "Riadna" | "Mimoriadna" | ...
  konsolidovana?: boolean;
  datumPodania?: string;
  datumSchvalenia?: string;
  zdrojDat?: string;
}

export interface Attachment {
  id: number;
  meno?: string;
  mimeType?: string;
  velkostPrilohy?: number;
  pocetStran?: number;
  jazyk?: string;
}

export interface Report {
  id: number;
  stav?: string;
  idUctovnejZavierky?: number;
  idSablony?: number;
  obsah?: { tabulky?: ReportTable[] };  // {} when structured data absent
  prilohy?: Attachment[];
  pristupnostDat?: string;
  zdrojDat?: string;
}

export interface ReportTable {
  nazov?: { sk?: string };
  data?: string[];               // flat, row-major: data[row * dataCols + col]
}

export interface AnnualReport {
  id: number;
  stav?: string;
  idUJ?: number;
  obdobieOd?: string;
  obdobieDo?: string;
  prilohy?: Attachment[];
  zdrojDat?: string;
}

export interface TemplateRow {
  text?: { sk?: string };
  cisloRiadku: number;
}

export interface TemplateTable {
  nazov?: { sk?: string };
  riadky?: TemplateRow[];
  pocetStlpcov?: number;
  pocetDatovychStlpcov?: number; // number of numeric data columns per row
}

export interface Template {
  id: number;
  nazov?: string;
  nariadenieMF?: string;
  platneOd?: string;
  tabulky?: TemplateTable[];
}

// Domain output shapes -----------------------------------------------------

export interface IndicatorValue {
  key: string;                   // e.g. "revenue"
  label: string;                 // human label
  value: number | null;
  cisloRiadku: number | null;    // statutory row number the value came from
  available: boolean;
}

export interface YearFinancials {
  year: number;
  periodOd?: string;
  periodDo?: string;
  consolidated: boolean;
  templateName?: string;
  structuredDataAvailable: boolean;
  attachmentHint?: string;       // set when structured data is unavailable
  indicators: IndicatorValue[];
}
