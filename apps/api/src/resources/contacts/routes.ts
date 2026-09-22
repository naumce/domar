import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireRole, WRITE_ROLES } from '../../auth/roles.js';
import { idParam } from '../common.js';
import { createContact, deleteContact, getContact, listContacts, updateContact } from './repo.js';
import { contactCreate, contactListQuery, contactOut, contactPatch, statementOut, statementQuery } from './schema.js';
import { ownerStatement } from './statement.js';

export const contactRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  const write = { preHandler: requireRole(...WRITE_ROLES) };

  app.get('/', { schema: { querystring: contactListQuery, response: { 200: z.object({ rows: z.array(contactOut), total: z.number() }) } } }, async (req) =>
    listContacts(req.db, req.ctx!, req.query));
  app.get('/:id', { schema: { params: idParam, response: { 200: contactOut } } }, async (req) => getContact(req.db, req.ctx!, req.params.id));
  app.get('/:id/statement', { schema: { params: idParam, querystring: statementQuery, response: { 200: statementOut } } }, async (req) =>
    ownerStatement(req.db, req.ctx!, req.params.id, req.query.buildingId));
  app.post('/', { ...write, schema: { body: contactCreate, response: { 201: contactOut } } }, async (req, reply) =>
    reply.status(201).send(await createContact(req.db, req.ctx!, req.body)));
  app.patch('/:id', { ...write, schema: { params: idParam, body: contactPatch, response: { 200: contactOut } } }, async (req) =>
    updateContact(req.db, req.ctx!, req.params.id, req.body));
  app.delete('/:id', { ...write, schema: { params: idParam } }, async (req, reply) => {
    await deleteContact(req.db, req.ctx!, req.params.id);
    return reply.status(204).send();
  });
};
