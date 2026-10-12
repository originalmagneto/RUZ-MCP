// Raw API shapes (subset of fields we use) ---------------------------------

export interface EntityIdsResponse {
  id: number[];
  existujeDalsieId: boolean;
}

export interface Entity {
  id: number;
  stav?: string;                 // "ZMAZANÉ" (deleted) or "Neverejná" (§ 23 ods. 8 z. 431/2002); absent on live records
  nazovUJ?: string;
  ico?: string;
  dic?: string;
  skNace?: string;
  pravnaForma?: string;
  velkostOrganizacie?: string;
  datumZalozenia?: string;
  datumZrusenia?: string;
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

export interface CodelistResponse {
  klasifikacie?: Array<{ kod: string; nazov?: { sk?: string; en?: string } }>;
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
  cisloRiadku: number | null;    // first statutory row the value came from
  rows?: number[];               // every statutory row summed into the value
  available: boolean;
}

/** Another statement filed for the same period as the one a year was built from. */
export interface OtherStatement {
  statementId: number;
  typ?: string;
  datumPodania?: string;
  datumSchvalenia?: string;
  structuredDataAvailable: boolean;
  templateNames: string[];
}

export interface YearFinancials {
  year: number;
  periodOd?: string;
  periodDo?: string;
  statementId?: number;          // statement the indicators were read from
  typ?: string;
  datumPodania?: string;
  datumSchvalenia?: string;
  consolidated: boolean;
  templateName?: string;         // template of the report the indicators came from
  templateNames?: string[];      // templates of every report in the statement
  structuredDataAvailable: boolean;
  attachmentHint?: string;       // set when structured data is unavailable
  otherStatements?: OtherStatement[]; // further statements filed for the same period
  note?: string;
  indicators: IndicatorValue[];
}
