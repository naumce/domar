import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireRole, WRITE_ROLES } from '../../auth/roles.js';
import { idParam } from '../common.js';
import { createBuilding, deleteBuilding, getBuilding, listBuildings, updateBuilding } from './repo.js';
import { buildingCreate, buildingListOut, buildingOut, buildingPatch } from './schema.js';

export const buildingRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  const write = { preHandler: requireRole(...WRITE_ROLES) };
  app.get('/', { schema: { response: { 200: z.object({ rows: z.array(buildingListOut) }) } } }, async (req) => listBuildings(req.db, req.ctx!));
  app.get('/:id', { schema: { params: idParam, response: { 200: buildingOut } } }, async (req) => getBuilding(req.db, req.ctx!, req.params.id));
  app.post('/', { ...write, schema: { body: buildingCreate, response: { 201: buildingOut } } }, async (req, reply) =>
    reply.status(201).send(await createBuilding(req.db, req.ctx!, req.body)));
  app.patch('/:id', { ...write, schema: { params: idParam, body: buildingPatch, response: { 200: buildingOut } } }, async (req) =>
    updateBuilding(req.db, req.ctx!, req.params.id, req.body));
  app.delete('/:id', { ...write, schema: { params: idParam } }, async (req, reply) => {
    await deleteBuilding(req.db, req.ctx!, req.params.id);
    return reply.status(204).send();
  });
};
