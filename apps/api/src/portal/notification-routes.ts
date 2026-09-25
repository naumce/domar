import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { listForOwner, markOwnerRead, removeSubscription, upsertSubscription } from '../notifications/repo.js';
import { notificationListOut } from '../notifications/schema.js';
import { idParam } from '../resources/common.js';
import { portalPushKeyOut, portalPushSubscribeBody, portalPushUnsubscribeBody } from './schema.js';

/** The owner's bell and the browser's push registration. Everything is keyed on the caller's account. */
export const portalNotificationRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requirePortal);

  app.get('/notifications', { schema: { response: { 200: notificationListOut } } }, async (req) =>
    listForOwner(req.db, req.portal!));

  app.post('/notifications/:id/read', { schema: { params: idParam } }, async (req, reply) => {
    await markOwnerRead(req.db, req.portal!, req.params.id);
    return reply.status(204).send();
  });

  // Only the public half, and null when push is not configured: the portal then hides the button.
  app.get('/push/key', { schema: { response: { 200: portalPushKeyOut } } }, async () => ({ publicKey: app.pusher.publicKey }));

  app.post('/push/subscribe', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { body: portalPushSubscribeBody },
  }, async (req, reply) => {
    await upsertSubscription(req.db, req.portal!, req.body);
    return reply.status(204).send();
  });

  app.post('/push/unsubscribe', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { body: portalPushUnsubscribeBody },
  }, async (req, reply) => {
    await removeSubscription(req.db, req.portal!, req.body.endpoint);
    return reply.status(204).send();
  });
};
