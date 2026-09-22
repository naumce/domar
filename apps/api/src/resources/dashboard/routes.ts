import { schema } from '@domar/db';
import { nextPeriod, periodStartDate } from '@domar/domain';
import { and, count, countDistinct, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { notFound } from '../../errors.js';

const B = schema.buildings; const U = schema.units; const INV = schema.invoices; const PAY = schema.payments; const T = schema.tenants;
const UNPAID_STATUSES = ['published', 'partially_paid'] as const;

const statsOut = z.object({
  totalProperties: z.number().int(), totalUnits: z.number().int(), assignedOwners: z.number().int(),
  billedThisMonthMinor: z.number().int(), paidThisMonthMinor: z.number().int(),
  unpaidInvoices: z.number().int(), outstandingMinor: z.number().int(),
});

/** `YYYY-MM` for the given instant, as observed in the given IANA zone. */
function formatPeriod(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).format(d);
}

export const dashboardRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get('/stats', { schema: { response: { 200: statsOut } } }, async (req) => {
    const ctx = req.ctx!;
    const db = req.db;
    const tenant = await db.query.tenants.findFirst({ where: eq(T.id, ctx.tenantId), columns: { timezone: true } });
    if (!tenant) throw notFound('Tenant');
    const period = formatPeriod(new Date(), tenant.timezone);
    const start = periodStartDate(period, tenant.timezone);
    const end = periodStartDate(nextPeriod(period), tenant.timezone);

    const [[properties], [units], [owners], [billed], [paid], [unpaid], [paidOfUnpaid]] = await Promise.all([
      db.select({ n: count() }).from(B).where(eq(B.tenantId, ctx.tenantId)),
      db.select({ n: count() }).from(U).where(eq(U.tenantId, ctx.tenantId)),
      db.select({ n: countDistinct(U.ownerContactId) }).from(U).where(and(eq(U.tenantId, ctx.tenantId), isNotNull(U.ownerContactId))),
      db.select({ total: sql<string>`coalesce(sum(${INV.totalMinor}), 0)` }).from(INV)
        .where(and(eq(INV.tenantId, ctx.tenantId), gte(INV.publishedAt, start), lt(INV.publishedAt, end))),
      db.select({ total: sql<string>`coalesce(sum(${PAY.amountMinor}), 0)` }).from(PAY)
        .where(and(eq(PAY.tenantId, ctx.tenantId), eq(PAY.status, 'completed'), gte(PAY.paidAt, start), lt(PAY.paidAt, end))),
      db.select({ n: count(), total: sql<string>`coalesce(sum(${INV.totalMinor}), 0)` }).from(INV)
        .where(and(eq(INV.tenantId, ctx.tenantId), inArray(INV.status, [...UNPAID_STATUSES]))),
      db.select({ total: sql<string>`coalesce(sum(${PAY.amountMinor}), 0)` }).from(PAY).innerJoin(INV, eq(INV.id, PAY.invoiceId))
        .where(and(eq(PAY.tenantId, ctx.tenantId), eq(PAY.status, 'completed'), eq(INV.tenantId, ctx.tenantId), inArray(INV.status, [...UNPAID_STATUSES]))),
    ]);

    return {
      totalProperties: Number(properties?.n ?? 0),
      totalUnits: Number(units?.n ?? 0),
      assignedOwners: Number(owners?.n ?? 0),
      billedThisMonthMinor: Number(billed?.total ?? 0),
      paidThisMonthMinor: Number(paid?.total ?? 0),
      unpaidInvoices: Number(unpaid?.n ?? 0),
      outstandingMinor: Number(unpaid?.total ?? 0) - Number(paidOfUnpaid?.total ?? 0),
    };
  });
};
