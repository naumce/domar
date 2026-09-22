import { type Db, schema } from '@domar/db';
import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { conflict, notFound } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { listPayments } from '../payments/repo.js';
import { claimPeriod } from '../periods/repo.js';

const INV = schema.invoices; const IL = schema.invoiceLines; const C = schema.contacts; const B = schema.buildings; const BP = schema.billingPeriods;

// "invoices"."id" is hard-coded rather than interpolated: how drizzle qualifies a column inside raw
// sql depends on the surrounding select, and an unqualified `id` would bind to the subquery's own row.
const paidMinorSql = sql<string>`(select coalesce(sum(p.amount_minor), 0) from ${schema.payments} p where p.tenant_id = "invoices"."tenant_id" and p.invoice_id = "invoices"."id" and p.status = 'completed')`;
const rowSelect = { inv: INV, period: BP.period, paidMinor: paidMinorSql, contact: { id: C.id, firstName: C.firstName, lastName: C.lastName }, building: { id: B.id, name: B.name } };
function joined(db: Db) {
  return db.select(rowSelect).from(INV).innerJoin(BP, eq(BP.id, INV.periodId)).innerJoin(C, eq(C.id, INV.contactId)).innerJoin(B, eq(B.id, INV.buildingId));
}
const toRow = (r: { inv: typeof INV.$inferSelect; period: string; paidMinor: string; contact: { id: string; firstName: string; lastName: string }; building: { id: string; name: string } }) => {
  const paidMinor = Number(r.paidMinor);
  return { ...r.inv, period: r.period, paidMinor, outstandingMinor: Math.max(0, r.inv.totalMinor - paidMinor), contact: r.contact, building: r.building };
};

export async function listInvoices(db: Db, ctx: TenantContext, q: { buildingId?: string | undefined; period?: string | undefined; status?: string | undefined; contactId?: string | undefined; page: number; pageSize: number }) {
  const conds = [eq(INV.tenantId, ctx.tenantId)];
  if (q.buildingId) conds.push(eq(INV.buildingId, q.buildingId));
  if (q.period) conds.push(eq(BP.period, q.period));
  if (q.status) conds.push(eq(INV.status, q.status as typeof INV.$inferSelect.status));
  if (q.contactId) conds.push(eq(INV.contactId, q.contactId));
  const where = and(...conds);
  const [rows, totalRows] = await Promise.all([
    joined(db).where(where).orderBy(desc(BP.period), asc(C.lastName), asc(C.firstName), asc(INV.id)).limit(q.pageSize).offset((q.page - 1) * q.pageSize),
    db.select({ total: count() }).from(INV).innerJoin(BP, eq(BP.id, INV.periodId)).where(where),
  ]);
  return { rows: rows.map(toRow), total: Number(totalRows[0]?.total ?? 0) };
}

export async function getInvoice(db: Db, ctx: TenantContext, id: string) {
  const [r] = await joined(db).where(and(eq(INV.tenantId, ctx.tenantId), eq(INV.id, id))).limit(1);
  if (!r) throw notFound('Invoice');
  const [contact, building, lines, payments] = await Promise.all([
    db.query.contacts.findFirst({ where: and(eq(C.tenantId, ctx.tenantId), eq(C.id, r.inv.contactId)) }),
    db.query.buildings.findFirst({ where: and(eq(B.tenantId, ctx.tenantId), eq(B.id, r.inv.buildingId)) }),
    db.query.invoiceLines.findMany({ where: and(eq(IL.tenantId, ctx.tenantId), eq(IL.invoiceId, id)), orderBy: [asc(IL.sortOrder)] }),
    listPayments(db, ctx, { invoiceId: id, page: 1, pageSize: 200 }),
  ]);
  return { ...toRow(r), contact: contact!, building: building!, lines, payments: payments.rows };
}

export async function deleteDraftInvoice(db: Db, ctx: TenantContext, id: string) {
  return db.transaction(async (tx) => {
    const inv = await tx.query.invoices.findFirst({ where: and(eq(INV.tenantId, ctx.tenantId), eq(INV.id, id)) });
    if (!inv) throw notFound('Invoice');
    if (inv.status !== 'draft') throw conflict('not_draft', 'Only draft invoices can be deleted');
    // Claim the period before touching the invoice: a concurrent publish either wins the row lock
    // (and we see 'published' here) or waits for us and finds no drafts left to number.
    await claimPeriod(tx, ctx, inv.buildingId, inv.periodId, ['open', 'generated']);
    const [deleted] = await tx.delete(INV).where(and(eq(INV.tenantId, ctx.tenantId), eq(INV.id, id), eq(INV.status, 'draft'))).returning({ id: INV.id });
    if (!deleted) throw conflict('not_draft', 'Only draft invoices can be deleted');
    const [left] = await tx.select({ n: count() }).from(INV).where(and(eq(INV.tenantId, ctx.tenantId), eq(INV.periodId, inv.periodId), eq(INV.status, 'draft')));
    if (Number(left?.n ?? 0) === 0) await tx.update(BP).set({ status: 'open', generatedAt: null, warnings: [], updatedAt: new Date() }).where(and(eq(BP.tenantId, ctx.tenantId), eq(BP.id, inv.periodId)));
    await writeAudit(tx, ctx, { action: 'invoice.delete_draft', entityType: 'invoice', entityId: id, before: inv });
  });
}
