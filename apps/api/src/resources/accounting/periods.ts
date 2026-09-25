import { type Db, schema } from '@domar/db';
import { nextPeriod } from '@domar/domain';
import { and, asc, eq } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { notFound } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { buildJournalFor } from './data.js';

const AP = schema.accountingPeriods; const U = schema.users;
export type AccountingPeriodRow = typeof AP.$inferSelect;

// `buildJournalFor` wants a logger for the one path that never should fire outside data corruption
// (a derivation invariant failing on postings the app itself already wrote — see its own docstring
// in `data.ts`). This repo layer has no `app.log`/`req.log` to thread through, and the signature
// below is the one Task 6 fixes, so `console.error` is the fallback rather than a new parameter.
const log = { error: (obj: unknown, msg: string) => console.error(msg, obj) };

export async function listAccountingPeriods(db: Db, ctx: TenantContext) {
  const rows = await db.select({ p: AP, firstName: U.firstName, lastName: U.lastName }).from(AP)
    .leftJoin(U, eq(U.id, AP.closedBy))
    .where(eq(AP.tenantId, ctx.tenantId))
    .orderBy(asc(AP.period));
  return {
    rows: rows.map((r) => ({
      ...r.p,
      closedByName: r.firstName ? `${r.firstName} ${r.lastName}`.trim() : null,
    })),
  };
}

/**
 * Advisory, not a lock (spec §5). Closing writes down what the month said when it was filed and
 * refuses nothing anywhere else; a posting that arrives afterwards comes back in the next export's
 * prior-period adjustments, which is what lets an accountant trust the file they already posted.
 * Re-closing is allowed and rewrites the totals, with who and when in the audit trail.
 *
 * The window is the period's own calendar month, expressed the same way every other window in this
 * product is — `YYYY-MM-DD` civil-day strings, `to` exclusive — so it goes through the exact same
 * `buildJournalFor` → `resolveWindow` → `collectFrom` path the preview and the export use. `period`
 * is already `YYYY-MM` (the route's `periodStr` param validates that), so its first day and the next
 * period's first day are plain string concatenation; no need to round-trip through `periodStartDate`
 * and back, since `buildJournalFor` resolves the civil day to an instant itself, in the tenant's own
 * zone, the one place that's allowed to.
 */
export async function closeAccountingPeriod(db: Db, ctx: TenantContext, period: string) {
  return db.transaction(async (tx) => {
    const { journal } = await buildJournalFor(tx, ctx, { from: `${period}-01`, to: `${nextPeriod(period)}-01` }, log);
    const [before] = await tx.select().from(AP).where(and(eq(AP.tenantId, ctx.tenantId), eq(AP.period, period))).limit(1);
    const values = {
      closedAt: new Date(), closedBy: ctx.userId,
      debitTotalMinor: journal.totals.debitMinor, creditTotalMinor: journal.totals.creditMinor,
      entryCount: journal.totals.entryCount,
    };
    // The unique index on (tenantId, period) makes this atomic: two concurrent closes of the same
    // period serialize on it rather than racing a read-then-insert into a duplicate row, and whichever
    // commits second simply rewrites the totals the first one wrote, same as a deliberate re-close.
    const [row] = await tx.insert(AP).values({ tenantId: ctx.tenantId, period, ...values })
      .onConflictDoUpdate({ target: [AP.tenantId, AP.period], set: { ...values, updatedAt: new Date() } }).returning();
    await writeAudit(tx, ctx, { action: 'accounting.period_close', entityType: 'accounting_period', entityId: row!.id, before: before ?? null, after: row });
    return row!;
  });
}

export async function reopenAccountingPeriod(db: Db, ctx: TenantContext, period: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [before] = await tx.delete(AP).where(and(eq(AP.tenantId, ctx.tenantId), eq(AP.period, period))).returning();
    if (!before) throw notFound('Accounting period');
    await writeAudit(tx, ctx, { action: 'accounting.period_reopen', entityType: 'accounting_period', entityId: before.id, before, after: null });
  });
}
