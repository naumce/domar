import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireRole, WRITE_ROLES } from '../../auth/roles.js';
import { idParam } from '../common.js';
import { createSupplier, deleteSupplier, listSuppliers, updateSupplier } from './repo.js';
import { supplierCreate, supplierListOut, supplierListQuery, supplierOut, supplierPatch } from './schema.js';

export const supplierRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  const write = { preHandler: requireRole(...WRITE_ROLES) };
  app.get('/', { schema: { querystring: supplierListQuery, response: { 200: supplierListOut } } }, async (req) =>
    listSuppliers(req.db, req.ctx!, req.query.includeInactive ?? false));
  app.post('/', { ...write, schema: { body: supplierCreate, response: { 201: supplierOut } } }, async (req, reply) =>
    reply.status(201).send(await createSupplier(req.db, req.ctx!, req.body)));
  app.patch('/:id', { ...write, schema: { params: idParam, body: supplierPatch, response: { 200: supplierOut } } }, async (req) =>
    updateSupplier(req.db, req.ctx!, req.params.id, req.body));
  app.delete('/:id', { ...write, schema: { params: idParam } }, async (req, reply) => {
    await deleteSupplier(req.db, req.ctx!, req.params.id);
    return reply.status(204).send();
  });
};
