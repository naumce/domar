import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireRole } from '../../auth/roles.js';
import { idParam } from '../common.js';
import { createUser, listUsers, resetUserPassword, updateUser } from './repo.js';
import { userCreate, userCreated, userOut, userPatch } from './schema.js';

/** /api/users — staff logins. Everything that changes a user is owner-only (spec §17.2). */
export const userRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  const ownerOnly = { preHandler: requireRole('owner') };

  app.get('/', { schema: { response: { 200: z.object({ rows: z.array(userOut) }) } } }, async (req) => listUsers(req.db, req.ctx!));
  app.post('/', { ...ownerOnly, schema: { body: userCreate, response: { 201: userCreated } } }, async (req, reply) =>
    reply.status(201).send(await createUser(req.db, req.ctx!, req.body)));
  app.patch('/:id', { ...ownerOnly, schema: { params: idParam, body: userPatch, response: { 200: userOut } } }, async (req) =>
    updateUser(req.db, req.ctx!, req.params.id, req.body));
  app.post('/:id/reset-password', { ...ownerOnly, schema: { params: idParam, response: { 200: userCreated } } }, async (req) =>
    resetUserPassword(req.db, req.ctx!, req.params.id));
};
