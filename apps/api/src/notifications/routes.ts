import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { idParam } from '../resources/common.js';
import { listForUser, markAllUserRead, markUserRead } from './repo.js';
import { notificationListOut } from './schema.js';

/** The manager's bell. Every role has one: a readonly user is told what changed, like anyone else. */
export const notificationRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get('/', { schema: { response: { 200: notificationListOut } } }, async (req) => listForUser(req.db, req.ctx!));

  app.post('/:id/read', { schema: { params: idParam } }, async (req, reply) => {
    await markUserRead(req.db, req.ctx!, req.params.id);
    return reply.status(204).send();
  });

  app.post('/read-all', {}, async (req, reply) => {
    await markAllUserRead(req.db, req.ctx!);
    return reply.status(204).send();
  });
};
