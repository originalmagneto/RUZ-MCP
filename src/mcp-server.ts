import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { looseBoolean, looseNumber } from "./scalars.js";
import { z } from "zod";
import { writeFileSync } from "node:fs";
import { RuzClient } from "./ruz-client.js";
import { assembleYear, buildRowIndex, currentColumn, priorColumn, cellValue } from "./financials.js";
import type { ReportWithTemplate } from "./financials.js";
import {
  classifyEntityStav, decodeCode, entityCandidate, entityStavNote, groupStatementsByPeriod,
  selectPrimaryStatement,
} from "./profile.js";
import type { EntityKind } from "./profile.js";
import type { Entity, Statement, YearFinancials } from "./types.js";

type Resolution =
  | { kind: "notFound" }
  | { kind: "one"; entity: Entity; deletedIds: number[] }
  | { kind: "many"; candidates: Entity[]; deletedIds: number[] }
  | { kind: "inactive"; entity: Entity; entityKind: EntityKind; deletedIds: number[] };

/** Say plainly when no year carries figures (IFRS filers), instead of six silent nulls. */
function profileNote(years: YearFinancials[]): string | undefined {
  if (years.length === 0) return "RÚZ neobsahuje pre tento výber žiadnu účtovnú závierku.";
  if (years.some((y) => y.structuredDataAvailable)) return undefined;
  const ifrs = years.some((y) => (y.templateNames ?? []).some((n) => /ifrs/i.test(n)));
  return (
    "Žiadna závierka v profile nemá v RÚZ štruktúrované dáta" +
    (ifrs ? " (subjekt podáva IFRS závierky, ku ktorým RÚZ čísla nezverejňuje)" : "") +
    ", preto sú všetky ukazovatele available: false — nie sú to nuly. Čísla sú iba v PDF prílohách " +
    "(ruz_list_attachments + ruz_download_attachment); dôvod pri každom roku uvádza attachmentHint."
  );
}

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function createRuzMcpServer(client = new RuzClient()): McpServer {
  const server = new McpServer({ name: "ruz-mcp", version: "0.2.0" });

  /**
   * Resolve the accounting unit behind an IČO/DIČ (or an explicit entityId).
   *
   * One IČO can carry several records: deleted ones ("ZMAZANÉ"), units moved to
   * the non-public part ("Neverejná") and — e.g. for natural persons — several
   * live units. Taking the first id hid live units behind a deleted record.
   */
  async function resolveEntity(ico?: string, dic?: string, entityId?: number): Promise<Resolution> {
    if (entityId != null) {
      const entity = await client.getEntity(entityId);
      const kind = classifyEntityStav(entity.stav);
      return kind === "live"
        ? { kind: "one", entity, deletedIds: [] }
        : { kind: "inactive", entity, entityKind: kind, deletedIds: [] };
    }
    const ids = ico ? await client.findEntityIdsByIco(ico) : dic ? await client.findEntityIdsByDic(dic) : [];
    if (ids.length === 0) return { kind: "notFound" };
    const entities = await Promise.all(ids.map((id) => client.getEntity(id)));
    const kinds = entities.map((e) => classifyEntityStav(e.stav));
    const live = entities.filter((_, i) => kinds[i] === "live");
    const deletedIds = entities.filter((_, i) => kinds[i] === "deleted").map((e) => e.id);
    if (live.length === 1) return { kind: "one", entity: live[0], deletedIds };
    if (live.length > 1) return { kind: "many", candidates: live, deletedIds };
    // No live unit: report the most informative inactive record.
    const pick = (["nonpublic", "other", "deleted"] as const)
      .map((k) => kinds.indexOf(k))
      .find((i) => i >= 0)!;
    return { kind: "inactive", entity: entities[pick], entityKind: kinds[pick], deletedIds };
  }

  /** Response for a resolution that does not yield exactly one live unit. */
  function unresolved(r: Exclude<Resolution, { kind: "one" }>, extra: Record<string, unknown>) {
    if (r.kind === "notFound") return json({ found: false, ...extra });
    if (r.kind === "many") {
      return json({
        found: true,
        ...extra,
        ambiguous: true,
        candidates: r.candidates.map(entityCandidate),
        deletedEntityIds: r.deletedIds,
        note:
          `Pod týmto identifikátorom je v RÚZ ${r.candidates.length} ${
            r.candidates.length <= 4 ? "živé účtovné jednotky" : "živých účtovných jednotiek"
          }. ` +
          "Zopakuj volanie s entityId vybranej jednotky.",
      });
    }
    return json({
      found: true,
      ...extra,
      entityId: r.entity.id,
      stav: r.entity.stav,
      note: entityStavNote(r.entityKind, r.entity.stav),
    });
  }

  server.registerTool(
    "ruz_find_entity",
    {
      title: "Nájdi účtovnú jednotku",
      description:
        "Nájde účtovnú jednotku v RÚZ podľa IČO alebo DIČ. Vracia všetky záznamy vrátane zmazaných " +
        "(stav „ZMAZANÉ“) a neverejných (stav „Neverejná“).",
      inputSchema: { ico: z.string().optional(), dic: z.string().optional() },
    },
    async ({ ico, dic }) => {
      const ids = ico
        ? await client.findEntityIdsByIco(ico)
        : dic
        ? await client.findEntityIdsByDic(dic)
        : [];
      const entities = await Promise.all(ids.map((id) => client.getEntity(id)));
      const kinds = entities.map((e) => classifyEntityStav(e.stav));
      const deleted = kinds.filter((k) => k === "deleted").length;
      const nonpublic = kinds.filter((k) => k === "nonpublic").length;
      const notes: string[] = [];
      if (deleted > 0) notes.push(`${deleted} záznam(y) so stavom ZMAZANÉ sú zmazané a nenesú žiadne údaje.`);
      if (nonpublic > 0) notes.push(`${nonpublic} záznam(y) so stavom Neverejná sú v neverejnej časti RÚZ.`);
      return json({
        count: entities.length,
        liveCount: kinds.filter((k) => k === "live").length,
        note: notes.length > 0 ? notes.join(" ") : undefined,
        entities,
      });
    },
  );

  server.registerTool(
    "ruz_financial_profile",
    {
      title: "Finančný profil",
      description:
        "Viacročný finančný profil subjektu podľa IČO: tržby (tovar + vlastné výrobky + služby), výsledok " +
        "hospodárenia, vlastné imanie, aktíva, záväzky, zadlženosť. Jeden riadok za účtovné obdobie; ak je " +
        "za obdobie viac závierok, uvedie, z ktorej sú čísla (statementId), a ostatné v otherStatements. " +
        "Ak je pod IČO viac živých jednotiek, vráti ich zoznam — zopakuj volanie s entityId.",
      inputSchema: {
        ico: z.string(),
        entityId: looseNumber(z.number().int()).optional(),
        years: looseNumber(z.number().int().min(1).max(15)).optional(),
        consolidated: looseBoolean().optional(),
      },
    },
    async ({ ico, entityId, years = 5, consolidated = false }) => {
      const resolution = await resolveEntity(ico, undefined, entityId);
      if (resolution.kind !== "one") return unresolved(resolution, { ico });
      const entity = resolution.entity;
      if (entityId != null && entity.ico && entity.ico !== ico) {
        return json({
          found: false,
          ico,
          entityId,
          note: `Jednotka ${entityId} má v RÚZ IČO ${entity.ico}, nie ${ico}. Over entityId cez ruz_find_entity.`,
        });
      }

      const statementIds = entity.idUctovnychZavierok ?? [];
      const statements = await Promise.all(statementIds.map((id) => client.getStatement(id)));
      const periods = groupStatementsByPeriod(
        statements.filter((s) => (consolidated ? s.konsolidovana : !s.konsolidovana)),
      ).slice(0, years);

      const [profile, entityOut] = await Promise.all([
        Promise.all(
          periods.map(async (group) =>
            selectPrimaryStatement(await Promise.all(group.map((stmt) => assembleStatement(stmt)))),
          ),
        ),
        describeEntity(entity),
      ]);

      return json({
        found: true,
        ico,
        entity: entityOut,
        consolidated,
        note: profileNote(profile),
        years: profile,
      });
    },
  );

  async function assembleStatement(stmt: Statement): Promise<YearFinancials> {
    const rwts: ReportWithTemplate[] = await Promise.all(
      (stmt.idUctovnychVykazov ?? []).map(async (rid) => {
        const report = await client.getReport(rid);
        const template = report.idSablony ? await client.getTemplate(report.idSablony) : { id: 0 };
        return { report, template };
      }),
    );
    return assembleYear(stmt, rwts);
  }

  /** Entity summary with codelist codes decoded; a codelist outage keeps the codes. */
  async function describeEntity(entity: Entity) {
    const [sizes, forms] = await Promise.allSettled([
      client.getCodelist("velkosti-organizacie"),
      client.getCodelist("pravne-formy"),
    ]);
    const sizeList = sizes.status === "fulfilled" ? sizes.value : null;
    const formList = forms.status === "fulfilled" ? forms.value : null;
    const missing = [!sizeList && "velkosti-organizacie", !formList && "pravne-formy"].filter(Boolean);
    return {
      entityId: entity.id,
      nazov: entity.nazovUJ,
      pravnaForma: decodeCode(formList, entity.pravnaForma),
      pravnaFormaKod: entity.pravnaForma,
      velkost: decodeCode(sizeList, entity.velkostOrganizacie),
      velkostKod: entity.velkostOrganizacie,
      datumZalozenia: entity.datumZalozenia,
      datumZrusenia: entity.datumZrusenia,
      codelistNote:
        missing.length > 0
          ? `Číselník RÚZ (${missing.join(", ")}) sa nepodarilo načítať; uvedený je iba kód.`
          : undefined,
    };
  }

  server.registerTool(
    "ruz_list_statements",
    {
      title: "Zoznam účtovných závierok",
      description: "Zoznam účtovných závierok jednotky (podľa IČO alebo entityId).",
      inputSchema: { ico: z.string().optional(), entityId: looseNumber(z.number().int()).optional() },
    },
    async ({ ico, entityId }) => {
      const resolution = await resolveEntity(ico, undefined, entityId);
      if (resolution.kind !== "one") return unresolved(resolution, { statements: [] });
      const entity = resolution.entity;
      const statements = await Promise.all(
        (entity.idUctovnychZavierok ?? []).map((sid) => client.getStatement(sid)),
      );
      return json({
        found: true,
        entityId: entity.id,
        statements: statements.map((s) => ({
          id: s.id, obdobieOd: s.obdobieOd, obdobieDo: s.obdobieDo, typ: s.typ,
          konsolidovana: s.konsolidovana, datumPodania: s.datumPodania,
          datumSchvalenia: s.datumSchvalenia, idUctovnychVykazov: s.idUctovnychVykazov,
        })),
      });
    },
  );

  server.registerTool(
    "ruz_get_statement",
    {
      title: "Detail účtovnej závierky",
      description: "Detail jednej účtovnej závierky vrátane jej výkazov (metadáta).",
      inputSchema: { statementId: looseNumber(z.number().int()) },
    },
    async ({ statementId }) => json(await client.getStatement(statementId)),
  );

  server.registerTool(
    "ruz_get_report",
    {
      title: "Plný účtovný výkaz",
      description:
        "Plný čitateľný výkaz (súvaha / výkaz ziskov a strát): riadky s názvami a hodnotami za bežné a predchádzajúce obdobie. Pri prázdnom obsahu vráti príznak a odkaz na prílohu.",
      inputSchema: { reportId: looseNumber(z.number().int()) },
    },
    async ({ reportId }) => {
      const report = await client.getReport(reportId);
      if (!report.idSablony) return json({ id: reportId, error: "no template id" });
      const template = await client.getTemplate(report.idSablony);
      const tables = template.tabulky ?? [];
      const reportTables = report.obsah?.tabulky ?? [];
      if (reportTables.length === 0) {
        return json({
          id: reportId,
          templateName: template.nazov,
          structuredDataAvailable: false,
          note: "Štruktúrované dáta nie sú dostupné. Použi ruz_list_attachments + ruz_download_attachment.",
          attachments: report.prilohy ?? [],
        });
      }
      const rendered = tables.map((t, ti) => {
        const idx = buildRowIndex(t);
        const rt = reportTables[ti];
        const cur = currentColumn(t);
        const prior = priorColumn(t);
        return {
          nazov: t.nazov?.sk,
          riadky: idx.rows.map((r) => ({
            cisloRiadku: r.cisloRiadku,
            nazov: r.label,
            bezne: rt ? cellValue(rt, t, r.position, cur) : null,
            predchadzajuce: rt && prior !== null ? cellValue(rt, t, r.position, prior) : null,
          })),
        };
      });
      return json({ id: reportId, templateName: template.nazov, structuredDataAvailable: true, tabulky: rendered });
    },
  );

  server.registerTool(
    "ruz_list_annual_reports",
    {
      title: "Zoznam výročných správ",
      description: "Zoznam výročných správ jednotky (podľa IČO alebo entityId).",
      inputSchema: { ico: z.string().optional(), entityId: looseNumber(z.number().int()).optional() },
    },
    async ({ ico, entityId }) => {
      const resolution = await resolveEntity(ico, undefined, entityId);
      if (resolution.kind !== "one") return unresolved(resolution, { annualReports: [] });
      const entity = resolution.entity;
      const reports = await Promise.all(
        (entity.idVyrocnychSprav ?? []).map((aid) => client.getAnnualReport(aid)),
      );
      return json({ found: true, annualReports: reports });
    },
  );

  server.registerTool(
    "ruz_list_attachments",
    {
      title: "Prílohy",
      description: "Zoznam PDF príloh k závierke, výkazu alebo výročnej správe.",
      inputSchema: {
        statementId: looseNumber(z.number().int()).optional(),
        reportId: looseNumber(z.number().int()).optional(),
        annualReportId: looseNumber(z.number().int()).optional(),
      },
    },
    async ({ statementId, reportId, annualReportId }) => {
      if (statementId != null) {
        const stmt = await client.getStatement(statementId);
        const reportIds = stmt.idUctovnychVykazov ?? [];
        const reports = await Promise.all(reportIds.map((rid) => client.getReport(rid)));
        const attachments = reports.flatMap((r) =>
          (r.prilohy ?? []).map((p) => ({ ...p, reportId: r.id })),
        );
        return json({ attachments });
      }
      if (reportId != null) {
        const r = await client.getReport(reportId);
        return json({ attachments: r.prilohy ?? [] });
      }
      if (annualReportId != null) {
        const a = await client.getAnnualReport(annualReportId);
        return json({ attachments: a.prilohy ?? [] });
      }
      return json({ attachments: [] });
    },
  );

  server.registerTool(
    "ruz_download_attachment",
    {
      title: "Stiahni prílohu",
      description: "Stiahne PDF prílohu. Buď vráti base64, alebo ju uloží na disk (savePath).",
      inputSchema: { attachmentId: looseNumber(z.number().int()), savePath: z.string().optional() },
    },
    async ({ attachmentId, savePath }) => {
      const { base64, contentType } = await client.downloadAttachment(attachmentId);
      const sizeBytes = Buffer.from(base64, "base64").length;
      if (savePath) {
        writeFileSync(savePath, Buffer.from(base64, "base64"));
        return json({ saved: true, path: savePath, contentType, sizeBytes });
      }
      return json({
        saved: false,
        contentType,
        sizeBytes,
        sizeMb: Number((sizeBytes / 1_048_576).toFixed(2)),
        note: sizeBytes > 2_000_000 ? "Veľký súbor — zváž použitie savePath namiesto inline base64." : undefined,
        base64,
      });
    },
  );

  return server;
}
