import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireRole, WRITE_ROLES } from '../../auth/roles.js';
import { loadChart, putAccountCode } from './chart.js';
import { buildJournalFor, type AccountingWindow } from './data.js';
import { DOCUMENT_READ_ROLES } from '../documents/routes.js';
import { exportAccounting, listAccountingExports } from './service.js';
import {
  accountCodeListOut, accountCodeOut, accountCodePut, accountSlotParam,
  accountingExportBody, accountingExportListOut, accountingExportOut,
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

/** Everything under `/api/accounting`. `/preview` is open to every role; the rest, Tasks 5 and 6. */
export const accountingRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get('/preview', { schema: { querystring: accountingWindowQuery, response: { 200: accountingPreviewOut } } }, async (req) => {
    const w = windowOf(req.query);
    const { journal, buildingName } = await buildJournalFor(req.db, req.ctx!, w, app.log);
    return {
      from: req.query.from, to: req.query.to, buildingName,
      trialBalance: journal.trialBalance, totals: journal.totals,
      adjustmentCount: journal.adjustments.length, closedPeriods: journal.closedPeriods,
      balanced: journal.totals.debitMinor === journal.totals.creditMinor,
    };
  });

  // Same read gate as the documents it lists (fix round 1, item 6): a technician may not list or
  // stream a document, and an accounting export is one, window and totals included.
  app.get('/exports', {
    preHandler: requireRole(...DOCUMENT_READ_ROLES),
    schema: { response: { 200: accountingExportListOut } },
  }, async (req) => listAccountingExports(req.db, req.ctx!));

  app.post('/export', {
    preHandler: requireRole(...WRITE_ROLES),
    schema: { body: accountingExportBody, response: { 201: accountingExportOut } },
  }, async (req, reply) => reply.status(201).send(await exportAccounting(req.db, req.ctx!, req.body, {
    documents: app.documents, log: app.log,
  })));
};
