import { type Db, schema } from '@domar/db';
import { and, desc, eq } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import type { DocumentStore } from '../../documents/store.js';
import type { TenantContext } from '../../tenant-context.js';
import { createDocumentFromBuffer } from '../documents/repo.js';
import { buildJournalFor } from './data.js';
import { buildAccountingExport, journalCounts } from './export.js';

const AU = schema.auditLogs; const D = schema.documents;

/** A listing this large would mean hundreds of exports filed against one tenant; item 7, fix round 1. */
const EXPORTS_LIST_LIMIT = 200;

export interface AccountingRuntime {
  documents: DocumentStore;
  log: { warn(obj: unknown, msg: string): void; error(obj: unknown, msg: string): void };
}

export interface AccountingExportInput {
  from: string;
  to: string;
  buildingId?: string | undefined;
}

/**
 * One transaction: the zip is built before anything is filed, and a failure anywhere takes the
 * document row *and* its bytes back with it — the same shape `resources/reports/service.ts` uses,
 * because a file with no row is an orphan nothing reaches.
 */
export async function exportAccounting(db: Db, ctx: TenantContext, input: AccountingExportInput, rt: AccountingRuntime) {
  return db.transaction(async (tx) => {
    const { journal, buildingName, tenantName, chart, timeZone } = await buildJournalFor(tx, ctx, {
      from: input.from, to: input.to, ...(input.buildingId ? { buildingId: input.buildingId } : {}),
    }, rt.log);
    // The file's own counts, so the response, the audit row, this export's line in `GET /exports`
    // and `README.txt` all say `Ставки: n` about the same n (fix round 2, item 5).
    const counts = journalCounts(journal);
    const createdAt = new Date();
    const zip = buildAccountingExport(journal, { tenantName, buildingName, from: input.from, to: input.to, createdAt, chart, timeZone });
    // The building id/name in both, so a tenant-wide and a per-building export of the same window
    // never file as two identically named, identically titled zips with different contents (fix
    // round 1, item 2) — `reports/service.ts` appends the id to its own file names the same way.
    const fileName = `smetkovodstvo-${input.from}-${input.to}${input.buildingId ? `-${input.buildingId}` : ''}.zip`;
    const document = await createDocumentFromBuffer(tx, ctx, rt.documents, {
      // `other`, not `report`: the portal shows owners reports of their building, and a journal of
      // the whole organization is for the accountant, never for a resident. `buildingId` is `null`
      // for a tenant-wide export — the `documents` table exists for exactly that case (a document
      // with no building is never shown to the portal).
      buildingId: input.buildingId ?? null, kind: 'other',
      title: `Сметководствен извоз ${input.from} — ${input.to}${buildingName ? ` — ${buildingName}` : ''}`,
      fileName, mime: 'application/zip', content: zip,
    });
    try {
      await writeAudit(tx, ctx, {
        action: 'accounting.export', entityType: 'document', entityId: document.id,
        after: {
          from: input.from, to: input.to, buildingId: input.buildingId ?? null, documentId: document.id,
          entryCount: counts.entryCount, adjustmentCount: counts.adjustmentCount,
          debitMinor: journal.totals.debitMinor, creditMinor: journal.totals.creditMinor,
          closedPeriods: journal.closedPeriods,
        },
      });
      return {
        documentId: document.id, fileName,
        entryCount: counts.entryCount, adjustmentCount: counts.adjustmentCount,
        debitMinor: journal.totals.debitMinor, creditMinor: journal.totals.creditMinor,
      };
    } catch (err) {
      try {
        await rt.documents.remove(document.storageKey);
      } catch (removeErr) {
        rt.log.warn({ err: removeErr, documentId: document.id }, 'accounting export rolled back but its file could not be removed');
      }
      throw err;
    }
  });
}

export interface AccountingExportRow {
  documentId: string;
  fileName: string;
  createdAt: Date;
  from: string;
  to: string;
  buildingId: string | null;
  entryCount: number;
  adjustmentCount: number;
  debitMinor: number;
  creditMinor: number;
  sizeBytes: number;
}

/**
 * Every zip this subsystem has filed, tenant-wide, newest first, up to `EXPORTS_LIST_LIMIT` (fix
 * round 1, item 7: this was unbounded). There is no `buildingId` to page `GET
 * /api/buildings/:id/documents` by for a tenant-wide export (`buildingId: null`), so without this the
 * id `POST /export` hands back is the only way that document is ever reachable again (controller
 * ruling). The audit row `exportAccounting` writes in the same transaction as the document is the
 * source of truth here, `innerJoin`ed to the document row for its file name and size — a `leftJoin`
 * would list a document someone deleted with an empty file name, which points at nothing (item 7).
 */
export async function listAccountingExports(db: Db, ctx: TenantContext): Promise<{ rows: AccountingExportRow[] }> {
  const rows = await db.select({ a: AU, fileName: D.fileName, sizeBytes: D.sizeBytes })
    .from(AU)
    .innerJoin(D, and(eq(D.id, AU.entityId), eq(D.tenantId, AU.tenantId)))
    .where(and(eq(AU.tenantId, ctx.tenantId), eq(AU.action, 'accounting.export')))
    .orderBy(desc(AU.createdAt))
    .limit(EXPORTS_LIST_LIMIT);
  return {
    rows: rows.map((r) => {
      const after = (r.a.after ?? {}) as Record<string, unknown>;
      return {
        documentId: r.a.entityId ?? '',
        fileName: r.fileName,
        createdAt: r.a.createdAt,
        from: typeof after.from === 'string' ? after.from : '',
        to: typeof after.to === 'string' ? after.to : '',
        buildingId: typeof after.buildingId === 'string' ? after.buildingId : null,
        entryCount: typeof after.entryCount === 'number' ? after.entryCount : 0,
        adjustmentCount: typeof after.adjustmentCount === 'number' ? after.adjustmentCount : 0,
        debitMinor: typeof after.debitMinor === 'number' ? after.debitMinor : 0,
        creditMinor: typeof after.creditMinor === 'number' ? after.creditMinor : 0,
        sizeBytes: Number(r.sizeBytes),
      };
    }),
  };
}
