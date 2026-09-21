import { type Db, schema } from '@domar/db';
import { and, asc, eq } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { conflict } from '../../errors.js';
import { addPostings, type NewPosting } from '../../ledger.js';
import type { TenantContext } from '../../tenant-context.js';
import { getPeriod, getPeriodRow } from '../periods/repo.js';
import { nextInvoiceNumber } from './numbering.js';

const INV = schema.invoices; const IL = schema.invoiceLines; const C = schema.contacts;
const DUE_DAYS = 15;

export async function publishPeriod(db: Db, ctx: TenantContext, buildingId: string, periodId: string) {
  return db.transaction(async (tx) => {
    const period = await getPeriodRow(tx, ctx, buildingId, periodId);
    if (period.status !== 'generated') throw conflict(period.status === 'published' ? 'period_locked' : 'nothing_to_publish', 'Generate drafts before publishing');
    const drafts = await tx.select({ inv: INV, lastName: C.lastName, firstName: C.firstName }).from(INV).innerJoin(C, eq(C.id, INV.contactId))
      .where(and(eq(INV.tenantId, ctx.tenantId), eq(INV.periodId, periodId), eq(INV.status, 'draft'))).orderBy(asc(C.lastName), asc(C.firstName));
    if (drafts.length === 0) throw conflict('nothing_to_publish', 'There are no draft invoices in this period');
    const issuedAt = new Date();
    const dueAt = new Date(issuedAt.getTime() + DUE_DAYS * 24 * 3600 * 1000);
    const postings: NewPosting[] = [];
    for (const { inv } of drafts) {
      const number = await nextInvoiceNumber(tx, ctx, issuedAt.getFullYear(), period.numberPrefix, period.numberSuffix);
      await tx.update(INV).set({ number, status: 'published', issuedAt, dueAt, publishedAt: issuedAt, updatedAt: issuedAt }).where(eq(INV.id, inv.id));
      const lines = await tx.select().from(IL).where(eq(IL.invoiceId, inv.id));
      for (const l of lines) {
        postings.push({ buildingId, account: 'owner', fund: l.fund, contactId: inv.contactId, kind: 'charge', amountMinor: l.ownerGrossMinor, refType: 'invoice', refId: inv.id, period: period.period, bookedAt: issuedAt });
      }
    }
    await addPostings(tx, ctx, postings);
    await tx.update(schema.billingPeriods).set({ status: 'published', issuedAt, dueAt, publishedAt: issuedAt, updatedAt: issuedAt }).where(eq(schema.billingPeriods.id, periodId));
    await writeAudit(tx, ctx, { action: 'period.publish', entityType: 'billing_period', entityId: periodId, after: { invoices: drafts.length, issuedAt, dueAt } });
    const detail = await getPeriod(tx, ctx, buildingId, periodId);
    return { period: detail, invoiceCount: detail.invoiceCount, totalMinor: detail.totalMinor };
  });
}
