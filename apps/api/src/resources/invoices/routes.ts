import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireRole, WRITE_ROLES } from '../../auth/roles.js';
import { idParam } from '../common.js';
import { deleteDraftInvoice, getInvoice, listInvoices } from './repo.js';
import { invoiceDetailOut, invoiceListQuery, invoiceRowOut } from './schema.js';

export const invoiceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  app.get('/', { schema: { querystring: invoiceListQuery, response: { 200: z.object({ rows: z.array(invoiceRowOut), total: z.number() }) } } }, async (req) => listInvoices(req.db, req.ctx!, req.query));
  app.get('/:id', { schema: { params: idParam, response: { 200: invoiceDetailOut } } }, async (req) => getInvoice(req.db, req.ctx!, req.params.id));
  app.delete('/:id', { preHandler: requireRole(...WRITE_ROLES), schema: { params: idParam } }, async (req, reply) => { await deleteDraftInvoice(req.db, req.ctx!, req.params.id); return reply.status(204).send(); });
};
