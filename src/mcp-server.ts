import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeFileSync } from "node:fs";
import { RuzClient } from "./ruz-client.js";
import { assembleYear, buildRowIndex, currentColumn, priorColumn, cellValue } from "./financials.js";
import type { ReportWithTemplate } from "./financials.js";
import type { YearFinancials } from "./types.js";

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function createRuzMcpServer(client = new RuzClient()): McpServer {
  const server = new McpServer({ name: "ruz-mcp", version: "0.1.0" });

  // Helper: resolve a single entity id from ico/dic, preferring the first.
  async function resolveEntityId(ico?: string, dic?: string): Promise<number | null> {
    if (ico) { const ids = await client.findEntityIdsByIco(ico); return ids[0] ?? null; }
    if (dic) { const ids = await client.findEntityIdsByDic(dic); return ids[0] ?? null; }
    return null;
  }

  server.registerTool(
    "ruz_find_entity",
    {
      title: "Nájdi účtovnú jednotku",
      description: "Nájde účtovnú jednotku v RÚZ podľa IČO alebo DIČ.",
      inputSchema: { ico: z.string().optional(), dic: z.string().optional() },
    },
    async ({ ico, dic }) => {
      const ids = ico
        ? await client.findEntityIdsByIco(ico)
        : dic
        ? await client.findEntityIdsByDic(dic)
        : [];
      const entities = await Promise.all(ids.map((id) => client.getEntity(id)));
      return json({ count: entities.length, entities });
    },
  );

  server.registerTool(
    "ruz_financial_profile",
    {
      title: "Finančný profil",
      description:
        "Viacročný finančný profil subjektu podľa IČO: tržby, výsledok hospodárenia, vlastné imanie, aktíva, záväzky, zadlženosť.",
      inputSchema: {
        ico: z.string(),
        years: z.number().int().min(1).max(15).optional(),
        consolidated: z.boolean().optional(),
      },
    },
    async ({ ico, years = 5, consolidated = false }) => {
      const entityId = await resolveEntityId(ico);
      if (entityId === null) return json({ found: false, ico });
      const entity = await client.getEntity(entityId);
      if (entity.stav) return json({ found: true, ico, stav: entity.stav, note: "Neverejná jednotka." });

      const statementIds = entity.idUctovnychZavierok ?? [];
      const statements = await Promise.all(statementIds.map((id) => client.getStatement(id)));
      const filtered = statements
        .filter((s) => (consolidated ? s.konsolidovana : !s.konsolidovana))
        .filter((s) => s.obdobieDo)
        .sort((a, b) => (b.obdobieDo ?? "").localeCompare(a.obdobieDo ?? ""))
        .slice(0, years);

      const profile: YearFinancials[] = [];
      for (const stmt of filtered) {
        const reportIds = stmt.idUctovnychVykazov ?? [];
        const rwts: ReportWithTemplate[] = await Promise.all(
          reportIds.map(async (rid) => {
            const report = await client.getReport(rid);
            const template = report.idSablony ? await client.getTemplate(report.idSablony) : { id: 0 };
            return { report, template };
          }),
        );
        profile.push(assembleYear(stmt, rwts));
      }
      return json({
        found: true,
        ico,
        entity: { nazov: entity.nazovUJ, pravnaForma: entity.pravnaForma, velkost: entity.velkostOrganizacie },
        consolidated,
        years: profile,
      });
    },
  );

  server.registerTool(
    "ruz_list_statements",
    {
      title: "Zoznam účtovných závierok",
      description: "Zoznam účtovných závierok jednotky (podľa IČO alebo entityId).",
      inputSchema: { ico: z.string().optional(), entityId: z.number().int().optional() },
    },
    async ({ ico, entityId }) => {
      const id = entityId ?? (await resolveEntityId(ico));
      if (id == null) return json({ found: false });
      const entity = await client.getEntity(id);
      const statements = await Promise.all(
        (entity.idUctovnychZavierok ?? []).map((sid) => client.getStatement(sid)),
      );
      return json({
        found: true,
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
      inputSchema: { statementId: z.number().int() },
    },
    async ({ statementId }) => json(await client.getStatement(statementId)),
  );

  server.registerTool(
    "ruz_get_report",
    {
      title: "Plný účtovný výkaz",
      description:
        "Plný čitateľný výkaz (súvaha / výkaz ziskov a strát): riadky s názvami a hodnotami za bežné a predchádzajúce obdobie. Pri prázdnom obsahu vráti príznak a odkaz na prílohu.",
      inputSchema: { reportId: z.number().int() },
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
      inputSchema: { ico: z.string().optional(), entityId: z.number().int().optional() },
    },
    async ({ ico, entityId }) => {
      const id = entityId ?? (await resolveEntityId(ico));
      if (id == null) return json({ found: false });
      const entity = await client.getEntity(id);
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
        statementId: z.number().int().optional(),
        reportId: z.number().int().optional(),
        annualReportId: z.number().int().optional(),
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
      inputSchema: { attachmentId: z.number().int(), savePath: z.string().optional() },
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
