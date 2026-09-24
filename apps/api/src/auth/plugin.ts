import type { schema } from '@domar/db';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { unauthorized } from '../errors.js';
import { resolveSession, SESSION_COOKIE } from './session.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** preHandler: requires a valid session, populates request.ctx */
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }

  interface FastifyRequest {
    session: { token: string; user: typeof schema.users.$inferSelect; tenant: typeof schema.tenants.$inferSelect } | null;
  }
}

const plugin: FastifyPluginAsync = async (app) => {
  app.decorateRequest('ctx', null);
  app.decorateRequest('session', null);

  app.addHook('onRequest', async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const found = await resolveSession(req.db, token);
    if (!found || !found.user.isActive) return;
    req.ctx = { tenantId: found.tenant.id, userId: found.user.id, role: found.user.role };
    req.session = { token, user: found.user, tenant: found.tenant };
  });

  app.decorate('requireAuth', async (req: FastifyRequest) => {
    if (!req.ctx) throw unauthorized();
  });
};

export const authPlugin = fp(plugin, { name: 'auth', dependencies: ['db'] });
