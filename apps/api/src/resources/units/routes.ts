import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireRole, WRITE_ROLES } from '../../auth/roles.js';
import { createUnit, deleteUnit, listUnits, updateUnit } from './repo.js';
import { buildingParam, buildingUnitParam, unitCreate, unitOut, unitPatch } from './schema.js';

export const unitRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  const write = { preHandler: requireRole(...WRITE_ROLES) };
  app.get('/', { schema: { params: buildingParam, response: { 200: z.object({ rows: z.array(unitOut) }) } } }, async (req) =>
    listUnits(req.db, req.ctx!, req.params.buildingId));
  app.post('/', { ...write, schema: { params: buildingParam, body: unitCreate, response: { 201: unitOut } } }, async (req, reply) =>
    reply.status(201).send(await createUnit(req.db, req.ctx!, req.params.buildingId, req.body)));
  app.patch('/:id', { ...write, schema: { params: buildingUnitParam, body: unitPatch, response: { 200: unitOut } } }, async (req) =>
    updateUnit(req.db, req.ctx!, req.params.buildingId, req.params.id, req.body));
  app.delete('/:id', { ...write, schema: { params: buildingUnitParam } }, async (req, reply) => {
    await deleteUnit(req.db, req.ctx!, req.params.buildingId, req.params.id);
    return reply.status(204).send();
  });
};
