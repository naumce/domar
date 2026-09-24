import { schema } from '@domar/db';
import { getCountryPack, type CountryCode } from '@domar/domain';
import { and, eq } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError, conflict, isUniqueViolation, unauthorized } from '../errors.js';
import { changeOwnPassword } from '../resources/users/repo.js';
import { changePasswordBody, userOut } from '../resources/users/schema.js';
import { hashPassword, verifyPassword } from './password.js';
import { createSession, deleteSession, SESSION_COOKIE } from './session.js';

const publicTenant = z.object({ id: z.string(), slug: z.string(), name: z.string(), countryCode: z.string(), currency: z.string(), locale: z.string(), timezone: z.string() });
const meResponse = z.object({ user: userOut, tenant: publicTenant });

const slug = z.string().min(2).max(64).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'lowercase letters, digits and hyphens');
const password = z.string().min(10).max(200);

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const limited = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/register', {
    ...limited,
    schema: {
      body: z.object({
        tenant: z.object({ slug, name: z.string().min(1).max(200), countryCode: z.enum(['mk']) }),
        user: z.object({ email: z.string().email(), password, firstName: z.string().min(1).max(100), lastName: z.string().min(1).max(100) }),
      }),
      response: { 201: meResponse },
    },
  }, async (req, reply) => {
    const pack = getCountryPack(req.body.tenant.countryCode as CountryCode);
    const email = req.body.user.email.toLowerCase();
    const passwordHash = await hashPassword(req.body.user.password);
    const result = await req.db.transaction(async (tx) => {
      const existing = await tx.query.tenants.findFirst({ where: eq(schema.tenants.slug, req.body.tenant.slug) });
      if (existing) throw conflict('slug_taken', 'Organization slug is already taken');
      let tenant;
      try {
        [tenant] = await tx.insert(schema.tenants).values({
          slug: req.body.tenant.slug, name: req.body.tenant.name, countryCode: pack.code, currency: pack.currency, locale: pack.locale,
        }).returning();
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('slug_taken', 'Organization slug is already taken');
        throw err;
      }
      if (!tenant) throw new AppError(500, 'internal', 'tenant insert failed');
      const [user] = await tx.insert(schema.users).values({
        tenantId: tenant.id, email, passwordHash, firstName: req.body.user.firstName, lastName: req.body.user.lastName, role: 'owner',
      }).returning();
      if (!user) throw new AppError(500, 'internal', 'user insert failed');
      await tx.insert(schema.taxRates).values(pack.defaultTaxRates.map((r) => ({ tenantId: tenant.id, name: r.name, rateBp: r.rateBp, isDefault: r.isDefault })));
      return { tenant, user };
    });
    const session = await createSession(req.db, result.user.id, { userAgent: req.headers['user-agent'], ip: req.ip });
    setSessionCookie(reply, session.token, session.expiresAt, app.config.isProduction);
    return reply.status(201).send({ user: result.user, tenant: result.tenant });
  });

  app.post('/login', {
    ...limited,
    schema: { body: z.object({ tenantSlug: z.string().max(64), email: z.string().email(), password: z.string().max(200) }), response: { 200: meResponse } },
  }, async (req, reply) => {
    const invalid = () => new AppError(401, 'invalid_credentials', 'Invalid organization, email or password');
    const tenant = await req.db.query.tenants.findFirst({ where: eq(schema.tenants.slug, req.body.tenantSlug) });
    if (!tenant) throw invalid();
    const user = await req.db.query.users.findFirst({ where: and(eq(schema.users.tenantId, tenant.id), eq(schema.users.email, req.body.email.toLowerCase())) });
    if (!user || !(await verifyPassword(req.body.password, user.passwordHash))) throw invalid();
    if (!user.isActive) throw invalid();
    const session = await createSession(req.db, user.id, { userAgent: req.headers['user-agent'], ip: req.ip });
    setSessionCookie(reply, session.token, session.expiresAt, app.config.isProduction);
    return { user, tenant };
  });

  app.post('/logout', async (req, reply) => {
    if (req.session) await deleteSession(req.db, req.session.token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.status(204).send();
  });

  app.post('/change-password', { ...limited, schema: { body: changePasswordBody } }, async (req, reply) => {
    if (!req.session) throw unauthorized();
    await changeOwnPassword(req.db, req.ctx!, req.body.currentPassword, req.body.newPassword, req.session.token);
    return reply.status(204).send();
  });

  app.get('/me', { schema: { response: { 200: meResponse } } }, async (req) => {
    if (!req.session) throw unauthorized();
    return { user: req.session.user, tenant: req.session.tenant };
  });
};

function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date, secure: boolean) {
  reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure, path: '/', expires: expiresAt });
}
