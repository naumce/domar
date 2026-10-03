import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { unauthorized } from '../errors.js';
import { accountForIdentity } from './accounts.js';
import { listLinks, OWNER_SESSION_COOKIE, resolveOwnerSession } from './session.js';
import { createSupabaseIdentity, SUPABASE_PROVIDER, type SupabaseIdentity } from './supabase-identity.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** preHandler: requires a valid owner session, populates request.portal */
    requirePortal: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** The domko bridge's token verifier; a no-op when `SUPABASE_JWKS_URL` is unset. */
    supabaseIdentity: SupabaseIdentity;
  }
}

const plugin: FastifyPluginAsync = async (app) => {
  app.decorateRequest('portal', null);
  app.decorateRequest('ownerSession', null);
  // One verifier for the whole app, so the remote JWKS is fetched and cached once.
  app.decorate('supabaseIdentity', createSupabaseIdentity(app.config));

  // Runs on every request, like the staff hook. The two cookies have different names, so a staff
  // cookie can never produce a `portal` and an owner cookie can never produce a `ctx`; a browser
  // holding both simply carries both contexts, and neither route family reads the other's.
  app.addHook('onRequest', async (req) => {
    const token = req.cookies[OWNER_SESSION_COOKIE];
    if (token) {
      const found = await resolveOwnerSession(req.db, token);
      if (!found || !found.account.isActive) return;
      req.portal = { ownerAccountId: found.account.id, links: await listLinks(req.db, found.account.id) };
      req.ownerSession = { token, account: found.account };
      return;
    }
    // The domko bridge: no domar cookie, so a verified Supabase subject that is already mapped to an
    // owner account produces the very same `portal` object the cookie branch produces — same account,
    // same links, therefore exactly the same tenant scoping. `ownerSession` stays null: there is no
    // domar session behind this request, and the three routes that read it either guard for null
    // (`/logout`, `/change-password`) or fall back to the account row (`/me`).
    const subject = await app.supabaseIdentity.subject(req.headers.authorization);
    if (!subject) return;
    const account = await accountForIdentity(req.db, SUPABASE_PROVIDER, subject);
    if (!account || !account.isActive) return;
    req.portal = { ownerAccountId: account.id, links: await listLinks(req.db, account.id) };
  });

  app.decorate('requirePortal', async (req: FastifyRequest) => {
    if (!req.portal) throw unauthorized();
  });
};

export const portalAuthPlugin = fp(plugin, { name: 'portal-auth', dependencies: ['db'] });
