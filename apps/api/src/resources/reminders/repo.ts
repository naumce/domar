import { type Db, schema } from '@domar/db';
import type { PriorReminder, UnpaidInvoice } from '@domar/domain';
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { notFound } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';

const INV = schema.invoices; const BP = schema.billingPeriods; const R = schema.reminders; const C = schema.contacts;

// "invoices"."id" is hard-coded for the same reason as in resources/invoices/repo.ts: an unqualified
// `id` inside the correlated subquery would bind to the subquery's own row.
const paidMinorSql = sql<string>`(select coalesce(sum(p.amount_minor), 0) from ${schema.payments} p where p.tenant_id = "invoices"."tenant_id" and p.invoice_id = "invoices"."id" and p.status = 'completed')`;

export interface OwnerOverdue { contactId: string; invoices: UnpaidInvoice[] }

/** Overdue published invoices of a building, grouped by owner. Invoices without a due date never count. */
export async function overdueByOwner(db: Db, ctx: TenantContext, buildingId: string, now: Date): Promise<OwnerOverdue[]> {
  const rows = await db.select({ id: INV.id, contactId: INV.contactId, period: BP.period, dueAt: INV.dueAt, totalMinor: INV.totalMinor, paidMinor: paidMinorSql })
    .from(INV).innerJoin(BP, eq(BP.id, INV.periodId))
    .where(and(eq(INV.tenantId, ctx.tenantId), eq(INV.buildingId, buildingId), inArray(INV.status, ['published', 'partially_paid']), lt(INV.dueAt, now)));
  const byOwner = new Map<string, UnpaidInvoice[]>();
  for (const r of rows) {
    const outstandingMinor = r.totalMinor - Number(r.paidMinor);
    if (outstandingMinor <= 0) continue;
    const list = byOwner.get(r.contactId) ?? [];
    list.push({ id: r.id, period: r.period, dueAt: r.dueAt!.toISOString(), outstandingMinor });
    byOwner.set(r.contactId, list);
  }
  return [...byOwner].map(([contactId, invoices]) => ({ contactId, invoices })).sort((x, y) => x.contactId.localeCompare(y.contactId));
}

/**
 * Reminders created for this building since `since`, keyed by contact. A reminder that was created
 * but never sent (a pending letter, a failed email) still counts as sent, or the job would create a
 * duplicate every night.
 */
export async function priorRemindersByOwner(db: Db, ctx: TenantContext, buildingId: string, since: Date): Promise<Map<string, PriorReminder[]>> {
  const rows = await db.select({ contactId: R.contactId, sentAt: R.sentAt, createdAt: R.createdAt, invoiceIds: R.invoiceIds })
    .from(R).where(and(eq(R.tenantId, ctx.tenantId), eq(R.buildingId, buildingId), gte(R.createdAt, since)));
  const out = new Map<string, PriorReminder[]>();
  for (const r of rows) {
    const list = out.get(r.contactId) ?? [];
    list.push({ sentAt: (r.sentAt ?? r.createdAt).toISOString(), invoiceIds: r.invoiceIds });
    out.set(r.contactId, list);
  }
  return out;
}

export type ReminderRecord = typeof R.$inferSelect;

/** Adds the owner and the covered invoice numbers to raw reminder rows, keeping their order. */
export async function decorate(db: Db, ctx: TenantContext, rows: ReminderRecord[]) {
  if (rows.length === 0) return [];
  const contactIds = [...new Set(rows.map((r) => r.contactId))];
  const invoiceIds = [...new Set(rows.flatMap((r) => r.invoiceIds))];
  const [contacts, invoices] = await Promise.all([
    db.select({ id: C.id, firstName: C.firstName, lastName: C.lastName, email: C.email }).from(C).where(and(eq(C.tenantId, ctx.tenantId), inArray(C.id, contactIds))),
    invoiceIds.length === 0 ? Promise.resolve([]) : db.select({ id: INV.id, number: INV.number }).from(INV).where(and(eq(INV.tenantId, ctx.tenantId), inArray(INV.id, invoiceIds))),
  ]);
  const byContact = new Map(contacts.map((c) => [c.id, c]));
  const numberOf = new Map(invoices.map((i) => [i.id, i.number]));
  return rows.map((r) => ({
    id: r.id, buildingId: r.buildingId, contactId: r.contactId, reason: r.reason, invoiceIds: r.invoiceIds,
    invoiceNumbers: r.invoiceIds.map((id) => numberOf.get(id) ?? '').filter((n) => n !== ''),
    totalOutstandingMinor: r.totalOutstandingMinor, channel: r.channel, status: r.status,
    sentAt: r.sentAt, error: r.error,
    contact: byContact.get(r.contactId) ?? { id: r.contactId, firstName: '', lastName: '', email: null },
    createdAt: r.createdAt,
  }));
}

export async function listByBuilding(db: Db, ctx: TenantContext, buildingId: string) {
  const rows = await db.select().from(R)
    .where(and(eq(R.tenantId, ctx.tenantId), eq(R.buildingId, buildingId)))
    .orderBy(desc(R.createdAt), desc(R.id));
  return { rows: await decorate(db, ctx, rows) };
}

export async function listByIds(db: Db, ctx: TenantContext, ids: string[]) {
  if (ids.length === 0) return { rows: [] };
  const rows = await db.select().from(R).where(and(eq(R.tenantId, ctx.tenantId), inArray(R.id, ids))).orderBy(desc(R.createdAt), desc(R.id));
  return { rows: await decorate(db, ctx, rows) };
}

export async function getReminderRow(db: Db, ctx: TenantContext, id: string): Promise<ReminderRecord> {
  const row = await db.query.reminders.findFirst({ where: and(eq(R.tenantId, ctx.tenantId), eq(R.id, id)) });
  if (!row) throw notFound('Reminder');
  return row;
}
