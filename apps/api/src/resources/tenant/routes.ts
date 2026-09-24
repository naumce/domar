import { schema } from '@domar/db';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { writeAudit } from '../../audit.js';
import { requireRole } from '../../auth/roles.js';
import { badRequest, notFound } from '../../errors.js';
import { stripUndefined } from '../common.js';
import { tenantOut, tenantPatch } from './schema.js';

const T = schema.tenants;

export const tenantRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get('/', { schema: { response: { 200: tenantOut } } }, async (req) => {
    const row = await req.db.query.tenants.findFirst({ where: eq(T.id, req.ctx!.tenantId) });
    if (!row) throw notFound('Tenant');
    return { ...row, emailConfigured: app.mailer.configured };
  });

  app.patch('/', { preHandler: requireRole('owner'), schema: { body: tenantPatch, response: { 200: tenantOut } } }, async (req) => {
    if (req.body.timezone !== undefined) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: req.body.timezone });
      } catch {
        throw badRequest('validation', 'unknown timezone');
      }
    }
    return req.db.transaction(async (tx) => {
      const before = await tx.query.tenants.findFirst({ where: eq(T.id, req.ctx!.tenantId) });
      if (!before) throw notFound('Tenant');
      const [row] = await tx.update(T).set({ ...stripUndefined(req.body), updatedAt: new Date() }).where(eq(T.id, req.ctx!.tenantId)).returning();
      await writeAudit(tx, req.ctx!, { action: 'tenant.update', entityType: 'tenant', entityId: req.ctx!.tenantId, before, after: row });
      return { ...row!, emailConfigured: app.mailer.configured };
    });
  });
};
