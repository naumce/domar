import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { idParam } from '../resources/common.js';
import { listForUser, markAllUserRead, markUserRead } from './repo.js';
import { notificationListOut } from './schema.js';

/**
 * The manager's bell. The rows behind it are written to `owner` and `accountant` only
 * (`staffRecipients`): spec §10 gives a `technician` maintenance and buildings, and a `readonly`
 * user compliance and reports — neither has anything to do about a portal request or a failed send,
 * the only two events that ring this bell. The route itself stays open to every role, so a bell that
 * is empty for them is empty honestly rather than 403.
 */
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
