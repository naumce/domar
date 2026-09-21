import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireRole, WRITE_ROLES } from '../../auth/roles.js';
import { buildingParam, buildingUnitParam } from '../units/schema.js';
import { attachService, detachService, listBuildingServices, updateBuildingService } from './repo.js';
import { buildingServiceCreate, buildingServiceOut, buildingServicePatch } from './schema.js';

export const buildingServiceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  const write = { preHandler: requireRole(...WRITE_ROLES) };
  app.get('/', { schema: { params: buildingParam, response: { 200: z.object({ rows: z.array(buildingServiceOut) }) } } }, async (req) => listBuildingServices(req.db, req.ctx!, req.params.buildingId));
  app.post('/', { ...write, schema: { params: buildingParam, body: buildingServiceCreate, response: { 201: buildingServiceOut } } }, async (req, reply) => reply.status(201).send(await attachService(req.db, req.ctx!, req.params.buildingId, req.body)));
  app.patch('/:id', { ...write, schema: { params: buildingUnitParam, body: buildingServicePatch, response: { 200: buildingServiceOut } } }, async (req) => updateBuildingService(req.db, req.ctx!, req.params.buildingId, req.params.id, req.body));
  app.delete('/:id', { ...write, schema: { params: buildingUnitParam } }, async (req, reply) => { await detachService(req.db, req.ctx!, req.params.buildingId, req.params.id); return reply.status(204).send(); });
};
