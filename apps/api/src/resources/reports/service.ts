import { type Db, schema } from '@domar/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import type { DocumentStore } from '../../documents/store.js';
import { AppError } from '../../errors.js';
import { recordLegalEvent } from '../../legal-events.js';
import { renderAnnualReportHtml } from '../../pdf/annual-report-html.js';
import { renderHandoverReportHtml } from '../../pdf/handover-report-html.js';
import { htmlToPdf } from '../../pdf/html-to-pdf.js';
import type { TenantContext } from '../../tenant-context.js';
import { getBuilding } from '../buildings/repo.js';
import { createDocumentFromBuffer, listDocuments } from '../documents/repo.js';
import { annualReport, handoverReport } from './data.js';
import { buildHandoverExport } from './export.js';
import type { HandoverIssueBody } from './schema.js';

const LE = schema.legalEvents; const D = schema.documents;

export interface ReportRuntime {
  pdfBrowserChannel: string;
  documents: DocumentStore;
  log: { warn(obj: unknown, msg: string): void };
}

/** The two event kinds that make a document a *filed report* (plan addendum 1). */
const REPORT_EVENTS = ['annual_report_issued', 'handover_report_issued'] as const;

/**
 * There is no `reports` table: a filed report is a legal event pointing at a document. The list is
 * that join, newest first, beside the plain list of `report` documents so one somebody uploaded by
 * hand is visible too.
 */
export async function listReports(db: Db, ctx: TenantContext, buildingId: string) {
  await getBuilding(db, ctx, buildingId); // 404 across tenants
  const [rows, documents] = await Promise.all([
    db.select({ e: LE, title: D.title, fileName: D.fileName, sizeBytes: D.sizeBytes }).from(LE)
      .leftJoin(D, and(eq(D.id, LE.refId), eq(D.tenantId, LE.tenantId)))
      .where(and(eq(LE.tenantId, ctx.tenantId), eq(LE.buildingId, buildingId), inArray(LE.kind, [...REPORT_EVENTS])))
      .orderBy(desc(LE.occurredAt), desc(LE.seq)),
    listDocuments(db, ctx, buildingId, 'report'),
  ]);
  return {
    rows: rows.map((r) => ({
      eventId: r.e.id,
      kind: (r.e.kind === 'annual_report_issued' ? 'annual' : 'handover') as 'annual' | 'handover',
      occurredAt: r.e.occurredAt,
      documentId: r.e.refId,
      exportDocumentId: typeof r.e.evidence.exportDocumentId === 'string' ? r.e.evidence.exportDocumentId : null,
      title: r.title ?? '',
      fileName: r.fileName ?? '',
      sizeBytes: Number(r.sizeBytes ?? 0),
      evidence: r.e.evidence,
    })),
    documents: documents.rows,
  };
}

/**
 * One transaction, PDF included (plan addendum 13): a report row with no file, or an event with no
 * report, would be evidence of nothing. A dead renderer gives 503 and files nothing at all.
 */
export async function issueAnnualReport(db: Db, ctx: TenantContext, buildingId: string, year: number, rt: ReportRuntime) {
  return db.transaction(async (tx) => {
    const { building, tenant, pack, data } = await annualReport(tx, ctx, buildingId, year);
    const createdAt = new Date();
    const html = renderAnnualReportHtml({
      tenant, building, data, labels: pack.labels.reports,
      formatMoney: (minor) => pack.formatMoney(minor), timeZone: tenant.timezone, locale: 'mk', createdAt,
    });
    let pdf: Buffer;
    try {
      pdf = await htmlToPdf(html, rt.pdfBrowserChannel);
    } catch (err) {
      rt.log.warn({ err, buildingId, year }, 'annual report pdf render failed; nothing is filed');
      throw new AppError(503, 'pdf_unavailable', 'PDF rendering is not available on this server');
    }
    const document = await createDocumentFromBuffer(tx, ctx, rt.documents, {
      buildingId, kind: 'report',
      title: `${pack.labels.reports.annualTitle} ${year}`,
      fileName: `godisen-izvestaj-${year}-${buildingId}.pdf`, mime: 'application/pdf', content: pdf,
    });
    try {
      const regular = data.funds.find((f) => f.fund === 'regular')!.closingMinor;
      const reserve = data.funds.find((f) => f.fund === 'reserve')!.closingMinor;
      const event = await recordLegalEvent(tx, ctx, {
        buildingId, kind: 'annual_report_issued', refType: 'document', refId: document.id, occurredAt: createdAt,
        evidence: {
          year, documentId: document.id,
          fundClosing: { regular, reserve },
          debtorsCount: data.debtors.length,
          totalDebtMinor: Number(data.fields.totalDebtMinor ?? 0),
        },
      });
      await writeAudit(tx, ctx, {
        action: 'report.annual', entityType: 'document', entityId: document.id,
        after: { year, documentId: document.id, fields: data.fields },
      });
      return { document, exportDocumentId: null, eventId: event.id, year, fields: data.fields };
    } catch (err) {
      // The document row goes back with the transaction, so its bytes must go too: `createDocument`
      // only cleans up after *its own* failure, and a file with no row is an orphan nothing reaches.
      try {
        await rt.documents.remove(document.storageKey);
      } catch (removeErr) {
        rt.log.warn({ err: removeErr, documentId: document.id }, 'annual report rolled back but its file could not be removed');
      }
      throw err;
    }
  });
}

/**
 * Art. 30, one transaction: the report, the export and the event, or none of the three. The archive
 * is built **before** either document is filed, so its index is the documentation as it stood at the
 * handover rather than a list that contains itself (plan addendum 11).
 */
export async function issueHandoverReport(db: Db, ctx: TenantContext, buildingId: string, input: HandoverIssueBody, rt: ReportRuntime) {
  return db.transaction(async (tx) => {
    const { building, tenant, pack, data } = await handoverReport(tx, ctx, buildingId, {
      asOf: input.asOf, bankBalances: input.bankBalances, note: input.note ?? null,
    });
    const createdAt = new Date();
    const html = renderHandoverReportHtml({
      tenant, building, data, labels: pack.labels.reports,
      formatMoney: (minor) => pack.formatMoney(minor), timeZone: tenant.timezone, locale: 'mk', createdAt,
    });
    let pdf: Buffer;
    try {
      pdf = await htmlToPdf(html, rt.pdfBrowserChannel);
    } catch (err) {
      rt.log.warn({ err, buildingId, asOf: input.asOf }, 'handover report pdf render failed; nothing is filed');
      throw new AppError(503, 'pdf_unavailable', 'PDF rendering is not available on this server');
    }
    const zip = await buildHandoverExport(tx, ctx, buildingId, data);
    const title = `${pack.labels.reports.handoverTitle} ${input.asOf}`;
    const filed: { id: string; storageKey: string }[] = [];
    try {
      const document = await createDocumentFromBuffer(tx, ctx, rt.documents, {
        buildingId, kind: 'report', title,
        fileName: `primopredavanje-${input.asOf}-${buildingId}.pdf`, mime: 'application/pdf', content: pdf,
      });
      filed.push(document);
      const exportDocument = await createDocumentFromBuffer(tx, ctx, rt.documents, {
        // `other`, not `report`: the portal shows reports to owners, and the full data export of a
        // building is for the incoming manager, not for a resident (plan addendum 12).
        buildingId, kind: 'other', title: `${title} — податоци`,
        fileName: `primopredavanje-${input.asOf}-${buildingId}.zip`, mime: 'application/zip', content: zip,
      });
      filed.push(exportDocument);
      const event = await recordLegalEvent(tx, ctx, {
        buildingId, kind: 'handover_report_issued', refType: 'document', refId: document.id, occurredAt: createdAt,
        evidence: {
          asOf: input.asOf,
          contractEndsOn: data.fields.contractEndsOn === '' ? null : data.fields.contractEndsOn,
          documentId: document.id,
          exportDocumentId: exportDocument.id,
          ownersCount: data.owners.length,
          totalDebtMinor: Number(data.fields.totalDebtMinor ?? 0),
          bankBalances: { regularMinor: input.bankBalances.regularMinor, reserveMinor: input.bankBalances.reserveMinor },
        },
      });
      await writeAudit(tx, ctx, {
        action: 'report.handover', entityType: 'document', entityId: document.id,
        after: { asOf: input.asOf, documentId: document.id, exportDocumentId: exportDocument.id, fields: data.fields },
      });
      return {
        document, exportDocumentId: exportDocument.id, eventId: event.id,
        year: Number(input.asOf.slice(0, 4)), fields: data.fields,
      };
    } catch (err) {
      // Both rows go back with the transaction, so both files must go too.
      for (const d of filed) {
        try {
          await rt.documents.remove(d.storageKey);
        } catch (removeErr) {
          rt.log.warn({ err: removeErr, documentId: d.id }, 'handover rolled back but its file could not be removed');
        }
      }
      throw err;
    }
  });
}
