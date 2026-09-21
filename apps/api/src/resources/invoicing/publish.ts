import { type Db, schema } from '@domar/db';
import { and, asc, eq } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { conflict, isUniqueViolation } from '../../errors.js';
import { addPostings, type NewPosting } from '../../ledger.js';
import type { TenantContext } from '../../tenant-context.js';
import { getPeriod, getPeriodRow } from '../periods/repo.js';
import { nextInvoiceNumber } from './numbering.js';

const INV = schema.invoices; const IL = schema.invoiceLines; const C = schema.contacts; const BP = schema.billingPeriods;
const DUE_DAYS = 15;

export async function publishPeriod(db: Db, ctx: TenantContext, buildingId: string, periodId: string) {
  return db.transaction(async (tx) => {
    // Claim the row first: only a period still 'generated' can transition, and the update takes a
    // row lock for the rest of the transaction, so a concurrent publish loses the race here instead
    // of racing on the numbering/posting work below.
    const [claimed] = await tx.update(BP).set({ status: 'published', updatedAt: new Date() })
      .where(and(eq(BP.tenantId, ctx.tenantId), eq(BP.buildingId, buildingId), eq(BP.id, periodId), eq(BP.status, 'generated')))
      .returning();
    if (!claimed) {
      const p = await getPeriodRow(tx, ctx, buildingId, periodId);
      throw conflict(p.status === 'published' ? 'period_locked' : 'nothing_to_publish', 'Generate drafts before publishing');
    }
    const drafts = await tx.select({ inv: INV, lastName: C.lastName, firstName: C.firstName }).from(INV).innerJoin(C, eq(C.id, INV.contactId))
      .where(and(eq(INV.tenantId, ctx.tenantId), eq(INV.periodId, periodId), eq(INV.status, 'draft'))).orderBy(asc(C.lastName), asc(C.firstName), asc(INV.id));
    if (drafts.length === 0) throw conflict('nothing_to_publish', 'There are no draft invoices in this period');
    const issuedAt = new Date();
    const dueAt = new Date(issuedAt.getTime() + DUE_DAYS * 24 * 3600 * 1000);
    const postings: NewPosting[] = [];
    for (const { inv } of drafts) {
      const number = await nextInvoiceNumber(tx, ctx, issuedAt.getFullYear(), claimed.numberPrefix, claimed.numberSuffix);
      let updated: { id: string } | undefined;
      try {
        [updated] = await tx.update(INV).set({ number, status: 'published', issuedAt, dueAt, publishedAt: issuedAt, updatedAt: issuedAt })
          .where(and(eq(INV.id, inv.id), eq(INV.tenantId, ctx.tenantId), eq(INV.status, 'draft'))).returning({ id: INV.id });
      } catch (e) {
        if (isUniqueViolation(e)) throw conflict('number_conflict', 'Invoice number already exists; check the period suffix');
        throw e;
      }
      if (!updated) throw conflict('publish_conflict', 'Invoice was modified concurrently');
      const lines = await tx.select().from(IL).where(and(eq(IL.tenantId, ctx.tenantId), eq(IL.invoiceId, inv.id)));
      for (const l of lines) {
        postings.push({ buildingId, account: 'owner', fund: l.fund, contactId: inv.contactId, kind: 'charge', amountMinor: l.ownerGrossMinor, refType: 'invoice', refId: inv.id, period: claimed.period, bookedAt: issuedAt });
      }
    }
    await addPostings(tx, ctx, postings);
    await tx.update(BP).set({ issuedAt, dueAt, publishedAt: issuedAt, updatedAt: issuedAt }).where(and(eq(BP.tenantId, ctx.tenantId), eq(BP.id, periodId)));
    await writeAudit(tx, ctx, { action: 'period.publish', entityType: 'billing_period', entityId: periodId, after: { invoices: drafts.length, issuedAt, dueAt } });
    const detail = await getPeriod(tx, ctx, buildingId, periodId);
    return { period: detail, invoiceCount: detail.invoiceCount, totalMinor: detail.totalMinor };
  });
}
