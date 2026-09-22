import { type Db, schema } from '@domar/db';
import { and, asc, count, desc, eq, gte, ilike, lt, or, sql } from 'drizzle-orm';
import { notFound } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';

const PAY = schema.payments; const C = schema.contacts; const INV = schema.invoices; const B = schema.buildings;
const shape = { p: PAY, contact: { id: C.id, firstName: C.firstName, lastName: C.lastName }, invoice: { id: INV.id, number: INV.number }, building: { id: B.id, name: B.name } };
const joined = (db: Db) => db.select(shape).from(PAY).innerJoin(C, eq(C.id, PAY.contactId)).leftJoin(INV, eq(INV.id, PAY.invoiceId)).innerJoin(B, eq(B.id, PAY.buildingId));
const toOut = (r: { p: typeof PAY.$inferSelect; contact: { id: string; firstName: string; lastName: string }; invoice: { id: string | null; number: string | null } | null; building: { id: string; name: string } }) =>
  ({ ...r.p, contact: r.contact, invoice: r.invoice?.id ? { id: r.invoice.id, number: r.invoice.number } : null, building: r.building });

export interface PaymentListQuery {
  buildingId?: string | undefined; contactId?: string | undefined; invoiceId?: string | undefined; method?: string | undefined; status?: string | undefined;
  from?: string | undefined; to?: string | undefined; search?: string | undefined; page: number; pageSize: number;
}

export async function listPayments(db: Db, ctx: TenantContext, q: PaymentListQuery) {
  const conds = [eq(PAY.tenantId, ctx.tenantId)];
  if (q.buildingId) conds.push(eq(PAY.buildingId, q.buildingId));
  if (q.contactId) conds.push(eq(PAY.contactId, q.contactId));
  if (q.invoiceId) conds.push(eq(PAY.invoiceId, q.invoiceId));
  if (q.method) conds.push(eq(PAY.method, q.method as typeof PAY.$inferSelect.method));
  if (q.status) conds.push(eq(PAY.status, q.status as typeof PAY.$inferSelect.status));
  if (q.from) conds.push(gte(PAY.paidAt, new Date(q.from)));
  if (q.to) conds.push(lt(PAY.paidAt, new Date(q.to)));
  if (q.search) { const term = `%${q.search.replace(/[\\%_]/g, (m) => '\\' + m)}%`; conds.push(or(ilike(PAY.reference, term), ilike(INV.number, term))!); }
  const where = and(...conds);
  const [rows, totalRows, summaryRows, byMethod] = await Promise.all([
    joined(db).where(where).orderBy(desc(PAY.paidAt), desc(PAY.createdAt), asc(PAY.id)).limit(q.pageSize).offset((q.page - 1) * q.pageSize),
    db.select({ total: count() }).from(PAY).leftJoin(INV, eq(INV.id, PAY.invoiceId)).where(where),
    db.select({ status: PAY.status, n: count(), total: sql<string>`coalesce(sum(${PAY.amountMinor}), 0)` }).from(PAY).leftJoin(INV, eq(INV.id, PAY.invoiceId)).where(where).groupBy(PAY.status),
    db.select({ method: PAY.method, total: sql<string>`coalesce(sum(${PAY.amountMinor}), 0)` }).from(PAY).leftJoin(INV, eq(INV.id, PAY.invoiceId)).where(and(where, eq(PAY.status, 'completed'))).groupBy(PAY.method),
  ]);
  const completed = summaryRows.find((s) => s.status === 'completed'); const voided = summaryRows.find((s) => s.status === 'voided');
  return {
    rows: rows.map(toOut), total: Number(totalRows[0]?.total ?? 0),
    summary: { totalMinor: Number(completed?.total ?? 0), completedCount: Number(completed?.n ?? 0), voidedCount: Number(voided?.n ?? 0), byMethod: byMethod.map((m) => ({ method: m.method, totalMinor: Number(m.total) })) },
  };
}

/** Payments of one invoice, newest first; 404s when the invoice is not this tenant's. */
export async function listInvoicePayments(db: Db, ctx: TenantContext, invoiceId: string) {
  const [inv] = await db.select({ id: INV.id }).from(INV).where(and(eq(INV.tenantId, ctx.tenantId), eq(INV.id, invoiceId))).limit(1);
  if (!inv) throw notFound('Invoice');
  return { rows: (await listPayments(db, ctx, { invoiceId, page: 1, pageSize: 200 })).rows };
}

export async function getPayment(db: Db, ctx: TenantContext, id: string) {
  const [r] = await joined(db).where(and(eq(PAY.tenantId, ctx.tenantId), eq(PAY.id, id))).limit(1);
  if (!r) throw notFound('Payment');
  return toOut(r);
}
