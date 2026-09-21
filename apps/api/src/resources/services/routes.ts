import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireRole, WRITE_ROLES } from '../../auth/roles.js';
import { idParam } from '../common.js';
import { createService, deactivateService, getService, listServices, updateService } from './repo.js';
import { serviceCreate, serviceListQuery, serviceOut, servicePatch } from './schema.js';

export const serviceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  const write = { preHandler: requireRole(...WRITE_ROLES) };
  app.get('/', { schema: { querystring: serviceListQuery, response: { 200: z.object({ rows: z.array(serviceOut) }) } } }, async (req) => listServices(req.db, req.ctx!, req.query));
  app.get('/:id', { schema: { params: idParam, response: { 200: serviceOut } } }, async (req) => getService(req.db, req.ctx!, req.params.id));
  app.post('/', { ...write, schema: { body: serviceCreate, response: { 201: serviceOut } } }, async (req, reply) => reply.status(201).send(await createService(req.db, req.ctx!, req.body)));
  app.patch('/:id', { ...write, schema: { params: idParam, body: servicePatch, response: { 200: serviceOut } } }, async (req) => updateService(req.db, req.ctx!, req.params.id, req.body));
  app.delete('/:id', { ...write, schema: { params: idParam } }, async (req, reply) => { await deactivateService(req.db, req.ctx!, req.params.id); return reply.status(204).send(); });
};
