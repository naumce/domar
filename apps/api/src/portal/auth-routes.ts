import type { FastifyReply } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { unauthorized } from '../errors.js';
import { changePortalPassword, describeLinks, linkAnotherContact, loginPortalAccount, portalMe, registerPortalAccount } from './accounts.js';
import { portalChangePasswordBody, portalLinkBody, portalLinkOut, portalLoginBody, portalMeOut, portalRegisterBody } from './schema.js';
import { createOwnerSession, deleteOwnerSession, listLinks, OWNER_SESSION_COOKIE } from './session.js';

export const portalAuthRoutes: FastifyPluginAsyncZod = async (app) => {
  const limited = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/register', { ...limited, schema: { body: portalRegisterBody, response: { 201: portalMeOut } } }, async (req, reply) => {
    const account = await registerPortalAccount(req.db, req.body);
    const session = await createOwnerSession(req.db, account.id, { userAgent: req.headers['user-agent'], ip: req.ip });
    setOwnerCookie(reply, session.token, session.expiresAt, app.config.isProduction);
    return reply.status(201).send({ account: { id: account.id, email: account.email }, links: await describeLinks(req.db, await listLinks(req.db, account.id)) });
  });

  app.post('/login', { ...limited, schema: { body: portalLoginBody, response: { 200: portalMeOut } } }, async (req, reply) => {
    const account = await loginPortalAccount(req.db, req.body);
    const session = await createOwnerSession(req.db, account.id, { userAgent: req.headers['user-agent'], ip: req.ip });
    setOwnerCookie(reply, session.token, session.expiresAt, app.config.isProduction);
    return { account: { id: account.id, email: account.email }, links: await describeLinks(req.db, await listLinks(req.db, account.id)) };
  });

  app.post('/logout', async (req, reply) => {
    if (req.ownerSession) await deleteOwnerSession(req.db, req.ownerSession.token);
    reply.clearCookie(OWNER_SESSION_COOKIE, { path: '/' });
    return reply.status(204).send();
  });

  app.get('/me', { preHandler: app.requirePortal, schema: { response: { 200: portalMeOut } } }, async (req) =>
    portalMe(req.db, req.portal!, req.ownerSession!.account));

  app.post('/link', { ...limited, preHandler: app.requirePortal, schema: { body: portalLinkBody, response: { 201: portalLinkOut } } }, async (req, reply) =>
    reply.status(201).send(await linkAnotherContact(req.db, req.portal!, req.body.code)));

  app.post('/change-password', { ...limited, preHandler: app.requirePortal, schema: { body: portalChangePasswordBody } }, async (req, reply) => {
    if (!req.ownerSession) throw unauthorized();
    await changePortalPassword(req.db, req.portal!, req.body.currentPassword, req.body.newPassword, req.ownerSession.token);
    return reply.status(204).send();
  });
};

function setOwnerCookie(reply: FastifyReply, token: string, expiresAt: Date, secure: boolean) {
  reply.setCookie(OWNER_SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure, path: '/', expires: expiresAt });
}
