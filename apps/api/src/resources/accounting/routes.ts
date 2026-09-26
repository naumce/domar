import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireRole, WRITE_ROLES } from '../../auth/roles.js';
import { loadChart, putAccountCode } from './chart.js';
import { buildJournalFor, type AccountingWindow } from './data.js';
import { DOCUMENT_READ_ROLES } from '../documents/routes.js';
import { closeAccountingPeriod, listAccountingPeriods, reopenAccountingPeriod } from './periods.js';
import { journalCounts } from './export.js';
import { exportAccounting, listAccountingExports } from './service.js';
import {
  accountCodeListOut, accountCodeOut, accountCodePut, accountSlotParam,
  accountingExportBody, accountingExportListOut, accountingExportOut,
  accountingPeriodListOut, accountingPeriodOut, accountingPeriodParam,
  accountingPreviewOut, accountingWindowQuery,
} from './schema.js';

/**
 * /api/account-codes — the tenant's chart of accounts. A separate plugin from `accountingRoutes`
 * (Tasks 4-6, mounted at /accounting): each publishes routes only under its own prefix.
 *
 * Reads for every role, `readonly` included, same as the reports routes; mapping a slot is a write.
 */
export const accountCodeRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get('/', { schema: { response: { 200: accountCodeListOut } } }, async (req) => {
    const { rows, missing } = await loadChart(req.db, req.ctx!);
    return { rows, missing };
  });

  app.put('/:slot', {
    preHandler: requireRole(...WRITE_ROLES),
    schema: { params: accountSlotParam, body: accountCodePut, response: { 200: accountCodeOut } },
  }, async (req) => putAccountCode(req.db, req.ctx!, req.params.slot, req.body));
};

/** `to` is exclusive and both bounds are plain civil days, as every window in this product is. */
const windowOf = (q: { from: string; to: string; buildingId?: string | undefined }): AccountingWindow =>
  ({ from: q.from, to: q.to, ...(q.buildingId ? { buildingId: q.buildingId } : {}) });

/**
 * Everything under `/api/accounting`. Every read here is the tenant's own financial position — a
 * trial balance, the totals of a closed month, the zips already filed — so all three carry the same
 * gate the documents they describe carry (`DOCUMENT_READ_ROLES`): `readonly` reads them, as spec §7
 * requires, and a technician does not. Hiding the nav entry from a technician while leaving the
 * numbers one `curl` away was the weaker half of that pair.
 *
 * `/preview` and `/export` derive up to 366 days of the whole ledger in memory, so they are capped
 * at the same rate as `POST /reports/*`, which is limited on the same argument.
 */
export const accountingRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  const read = { preHandler: requireRole(...DOCUMENT_READ_ROLES) };
  const heavy = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.get('/preview', { ...read, ...heavy, schema: { querystring: accountingWindowQuery, response: { 200: accountingPreviewOut } } }, async (req) => {
    const w = windowOf(req.query);
    const { journal, buildingName } = await buildJournalFor(req.db, req.ctx!, w, app.log);
    return {
      from: req.query.from, to: req.query.to, buildingName,
      trialBalance: journal.trialBalance,
      // Debit and credit are the whole file's — they have to be, or the trial balance would not
      // close — while the counts are the journal's own, the same ones `README.txt` prints.
      totals: { debitMinor: journal.totals.debitMinor, creditMinor: journal.totals.creditMinor },
      ...journalCounts(journal),
      closedPeriods: journal.closedPeriods,
      balanced: journal.totals.debitMinor === journal.totals.creditMinor,
    };
  });

  // Same read gate as the documents it lists (fix round 1, item 6): a technician may not list or
  // stream a document, and an accounting export is one, window and totals included.
  app.get('/exports', { ...read, schema: { response: { 200: accountingExportListOut } } },
    async (req) => listAccountingExports(req.db, req.ctx!));

  app.post('/export', {
    preHandler: requireRole(...WRITE_ROLES), ...heavy,
    schema: { body: accountingExportBody, response: { 201: accountingExportOut } },
  }, async (req, reply) => reply.status(201).send(await exportAccounting(req.db, req.ctx!, req.body, {
    documents: app.documents, log: app.log,
  })));

  // A closed period's stored totals are the same financial reading as the preview above, so it
  // carries the same gate.
  app.get('/periods', { ...read, schema: { response: { 200: accountingPeriodListOut } } }, async (req) =>
    listAccountingPeriods(req.db, req.ctx!));

  app.post('/periods/:period/close', {
    preHandler: requireRole(...WRITE_ROLES),
    schema: { params: accountingPeriodParam, response: { 200: accountingPeriodOut } },
  }, async (req) => closeAccountingPeriod(req.db, req.ctx!, req.params.period, app.log));

  app.delete('/periods/:period', {
    preHandler: requireRole(...WRITE_ROLES),
    schema: { params: accountingPeriodParam },
  }, async (req, reply) => {
    await reopenAccountingPeriod(req.db, req.ctx!, req.params.period);
    return reply.status(204).send();
  });
};
