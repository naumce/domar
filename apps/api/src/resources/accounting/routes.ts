import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireRole, WRITE_ROLES } from '../../auth/roles.js';
import { loadChart, putAccountCode } from './chart.js';
import { accountCodeListOut, accountCodeOut, accountCodePut, accountSlotParam } from './schema.js';

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
