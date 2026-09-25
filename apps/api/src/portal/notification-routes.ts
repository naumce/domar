import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { listForOwner, markAllOwnerRead, markOwnerRead, removeSubscription, upsertSubscription } from '../notifications/repo.js';
import { notificationListOut } from '../notifications/schema.js';
import { idParam } from '../resources/common.js';
import { portalOptionalContactQuery, portalPushKeyOut, portalPushSubscribeBody, portalPushUnsubscribeBody } from './schema.js';

/** The owner's bell and the browser's push registration. Everything is keyed on the caller's account. */
export const portalNotificationRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requirePortal);

  app.get('/notifications', { schema: { querystring: portalOptionalContactQuery, response: { 200: notificationListOut } } }, async (req) =>
    listForOwner(req.db, req.portal!, req.query.contactId));

  app.post('/notifications/:id/read', { schema: { params: idParam } }, async (req, reply) => {
    await markOwnerRead(req.db, req.portal!, req.params.id);
    return reply.status(204).send();
  });

  // The scope travels in the query here, not the body: `read-all` is called with no body at all.
  app.post('/notifications/read-all', { schema: { querystring: portalOptionalContactQuery } }, async (req, reply) => {
    await markAllOwnerRead(req.db, req.portal!, req.query.contactId);
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
