import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireRole, WRITE_ROLES } from '../../auth/roles.js';
import { buildingParam } from '../units/schema.js';
import { createContract, deleteContract, listContracts, updateContract } from './repo.js';
import { contractCreate, contractListOut, contractOut, contractParam, contractPatch } from './schema.js';

export const contractRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  const write = { preHandler: requireRole(...WRITE_ROLES) };
  app.get('/', { schema: { params: buildingParam, response: { 200: contractListOut } } }, async (req) =>
    listContracts(req.db, req.ctx!, req.params.buildingId));
  app.post('/', { ...write, schema: { params: buildingParam, body: contractCreate, response: { 201: contractOut } } }, async (req, reply) =>
    reply.status(201).send(await createContract(req.db, req.ctx!, req.params.buildingId, req.body)));
  app.patch('/:id', { ...write, schema: { params: contractParam, body: contractPatch, response: { 200: contractOut } } }, async (req) =>
    updateContract(req.db, req.ctx!, req.params.buildingId, req.params.id, req.body));
  app.delete('/:id', { ...write, schema: { params: contractParam } }, async (req, reply) => {
    await deleteContract(req.db, req.ctx!, req.params.buildingId, req.params.id);
    return reply.status(204).send();
  });
};
