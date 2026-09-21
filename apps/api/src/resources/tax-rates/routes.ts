import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireRole, WRITE_ROLES } from '../../auth/roles.js';
import { createTaxRate, deactivateTaxRate, getTaxRate, listTaxRates, updateTaxRate } from './repo.js';
import { idParam, listQuery, taxRateCreate, taxRateOut, taxRatePatch } from './schema.js';

export const taxRateRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  const write = { preHandler: requireRole(...WRITE_ROLES) };

  app.get('/', { schema: { querystring: listQuery, response: { 200: z.object({ rows: z.array(taxRateOut) }) } } }, async (req) => ({
    rows: await listTaxRates(req.db, req.ctx!, req.query.includeInactive ?? false),
  }));
  app.get('/:id', { schema: { params: idParam, response: { 200: taxRateOut } } }, async (req) => getTaxRate(req.db, req.ctx!, req.params.id));
  app.post('/', { ...write, schema: { body: taxRateCreate, response: { 201: taxRateOut } } }, async (req, reply) =>
    reply.status(201).send(await createTaxRate(req.db, req.ctx!, req.body)));
  app.patch('/:id', { ...write, schema: { params: idParam, body: taxRatePatch, response: { 200: taxRateOut } } }, async (req) =>
    updateTaxRate(req.db, req.ctx!, req.params.id, req.body));
  app.delete('/:id', { ...write, schema: { params: idParam } }, async (req, reply) => {
    await deactivateTaxRate(req.db, req.ctx!, req.params.id);
    return reply.status(204).send();
  });
};
