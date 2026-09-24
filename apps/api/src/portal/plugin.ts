import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { unauthorized } from '../errors.js';
import { listLinks, OWNER_SESSION_COOKIE, resolveOwnerSession } from './session.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** preHandler: requires a valid owner session, populates request.portal */
    requirePortal: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const plugin: FastifyPluginAsync = async (app) => {
  app.decorateRequest('portal', null);
  app.decorateRequest('ownerSession', null);

  // Runs on every request, like the staff hook. The two cookies have different names, so a staff
  // cookie can never produce a `portal` and an owner cookie can never produce a `ctx`; a browser
  // holding both simply carries both contexts, and neither route family reads the other's.
  app.addHook('onRequest', async (req) => {
    const token = req.cookies[OWNER_SESSION_COOKIE];
    if (!token) return;
    const found = await resolveOwnerSession(req.db, token);
    if (!found || !found.account.isActive) return;
    req.portal = { ownerAccountId: found.account.id, links: await listLinks(req.db, found.account.id) };
    req.ownerSession = { token, account: found.account };
  });

  app.decorate('requirePortal', async (req: FastifyRequest) => {
    if (!req.portal) throw unauthorized();
  });
};

export const portalAuthPlugin = fp(plugin, { name: 'portal-auth', dependencies: ['db'] });
