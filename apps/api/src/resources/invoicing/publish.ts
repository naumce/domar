import { type Db, schema } from '@domar/db';
import { mulMinor } from '@domar/domain';
import { and, asc, eq } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { conflict, isUniqueViolation } from '../../errors.js';
import { addPostings, type NewPosting } from '../../ledger.js';
import { recordLegalEvent } from '../../legal-events.js';
import type { TenantContext } from '../../tenant-context.js';
import { getPeriod, getPeriodRow } from '../periods/repo.js';
import { nextInvoiceNumber } from './numbering.js';

const INV = schema.invoices; const IL = schema.invoiceLines; const C = schema.contacts; const BP = schema.billingPeriods; const PL = schema.periodLines; const T = schema.tenants;
const DUE_DAYS = 15;

/** The engine's basis, read back as the distribution the manager asked for (plan addendum 17). */
const DISTRIBUTION = { custom: 'share', equal: 'equal', area: 'area' } as const;

export interface PublishInput {
  dueAt?: Date | undefined;
  /** An alternative to `dueAt`: days from the issue date, so the due date is counted off the very moment stamped on the invoices. */
  dueDays?: number | undefined;
  /** Evidence only: the decision document an Art. 47(5) distribution rests on. */
  documentId?: string | null | undefined;
}

export async function publishPeriod(db: Db, ctx: TenantContext, buildingId: string, periodId: string, input: PublishInput = {}) {
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
    const tenant = await tx.query.tenants.findFirst({ where: eq(T.id, ctx.tenantId), columns: { timezone: true } });
    const issuedAt = new Date();
    const year = Number(new Intl.DateTimeFormat('en-US', { timeZone: tenant!.timezone, year: 'numeric' }).format(issuedAt));
    const dueAt = input.dueAt ?? new Date(issuedAt.getTime() + (input.dueDays ?? DUE_DAYS) * 24 * 3600 * 1000);
    const postings: NewPosting[] = [];
    for (const { inv } of drafts) {
      const number = await nextInvoiceNumber(tx, ctx, year, claimed.numberPrefix, claimed.numberSuffix);
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
    await recordLegalEvent(tx, ctx, {
      buildingId, kind: 'invoice_published', refType: 'billing_period', refId: periodId, occurredAt: issuedAt, dueAt,
      evidence: {
        period: claimed.period, periodKind: claimed.kind, invoiceCount: drafts.length,
        invoiceIds: drafts.map((d) => d.inv.id), totalMinor: drafts.reduce((s, d) => s + d.inv.totalMinor, 0),
      },
    });
    // Art. 47(5): the distribution becomes a legal fact the moment the invoices go out, so the event
    // is written here rather than by the caller — a manual publish of an extraordinary period from
    // the period page records it just as the extraordinary-costs route does.
    if (claimed.kind === 'extraordinary') {
      const lines = await tx.select().from(PL).where(and(eq(PL.tenantId, ctx.tenantId), eq(PL.periodId, periodId))).orderBy(asc(PL.sortOrder), asc(PL.createdAt));
      await recordLegalEvent(tx, ctx, {
        buildingId, kind: 'extraordinary_cost_distributed', refType: 'billing_period', refId: periodId, occurredAt: issuedAt, dueAt,
        evidence: {
          periodId, period: claimed.period,
          amountMinor: lines.reduce((s, l) => s + mulMinor(l.unitPriceMinor, Number(l.quantity)), 0),
          fund: lines[0]?.fund ?? null,
          distribution: claimed.distributionBasis ? DISTRIBUTION[claimed.distributionBasis] : null,
          distributionBasis: claimed.distributionBasis,
          appliesTo: lines[0]?.appliesTo ?? [],
          invoiceIds: drafts.map((d) => d.inv.id), invoiceCount: drafts.length,
          totalMinor: drafts.reduce((s, d) => s + d.inv.totalMinor, 0),
          documentId: input.documentId ?? null,
        },
      });
    }
    await writeAudit(tx, ctx, { action: 'period.publish', entityType: 'billing_period', entityId: periodId, after: { invoices: drafts.length, issuedAt, dueAt } });
    const detail = await getPeriod(tx, ctx, buildingId, periodId);
    return { period: detail, invoiceCount: detail.invoiceCount, totalMinor: detail.totalMinor };
  });
}
