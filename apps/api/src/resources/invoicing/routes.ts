import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireRole, WRITE_ROLES } from '../../auth/roles.js';
import { periodDetailOut, periodParam } from '../periods/schema.js';
import { deleteDrafts, generatePeriod } from './generate.js';
import { publishPeriod } from './publish.js';

const summaryOut = z.object({ period: periodDetailOut, invoiceCount: z.number().int(), totalMinor: z.number().int(), warnings: z.array(z.record(z.unknown())).optional(), skippedUnits: z.array(z.object({ unitId: z.string(), reason: z.string() })).optional() });

export const invoicingRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  const write = { preHandler: requireRole(...WRITE_ROLES) };
  app.post('/:id/generate', { ...write, schema: { params: periodParam, response: { 200: summaryOut } } }, async (req) => generatePeriod(req.db, req.ctx!, req.params.buildingId, req.params.id));
  app.delete('/:id/drafts', { ...write, schema: { params: periodParam, response: { 200: periodDetailOut } } }, async (req) => deleteDrafts(req.db, req.ctx!, req.params.buildingId, req.params.id));
  app.post('/:id/publish', { ...write, schema: { params: periodParam, response: { 200: summaryOut } } }, async (req) => publishPeriod(req.db, req.ctx!, req.params.buildingId, req.params.id));
};
