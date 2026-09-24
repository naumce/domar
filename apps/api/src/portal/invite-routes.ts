import type { FastifyInstance } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireRole, WRITE_ROLES } from '../auth/roles.js';
import { idParam } from '../resources/common.js';
import { issuePortalInvite, portalStatus, type PortalInviteRuntime } from './invites.js';
import { portalInviteOut, portalStatusOut } from './schema.js';

const runtime = (app: FastifyInstance): PortalInviteRuntime => ({ mailer: app.mailer, log: app.log });

/** Registered under `/contacts`, next to `contactRoutes`: the manager's half of the portal. */
export const contactPortalRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.post('/:id/portal-invite', {
    preHandler: requireRole(...WRITE_ROLES),
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { params: idParam, response: { 201: portalInviteOut } },
  }, async (req, reply) => reply.status(201).send(await issuePortalInvite(req.db, req.ctx!, req.params.id, runtime(app))));

  app.get('/:id/portal-status', { schema: { params: idParam, response: { 200: portalStatusOut } } }, async (req) =>
    portalStatus(req.db, req.ctx!, req.params.id));
};
