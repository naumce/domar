import { type Db, schema } from '@domar/db';
import { nextPeriod, periodStartDate } from '@domar/domain';
import { and, asc, eq } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { badRequest, notFound } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { tenantPack } from '../reports/data.js';
import { buildJournalFor } from './data.js';
import { journalCounts } from './export.js';

const AP = schema.accountingPeriods; const U = schema.users;
export type AccountingPeriodRow = typeof AP.$inferSelect;
type Log = { error(obj: unknown, msg: string): void };

export async function listAccountingPeriods(db: Db, ctx: TenantContext) {
  const rows = await db.select({ p: AP, firstName: U.firstName, lastName: U.lastName }).from(AP)
    // Tenant-scoped like every other join in `data.ts` (fix round 1, item 7): `closedBy` is a user
    // id with no tenant of its own to check, so an unscoped join would still be correct today (a
    // user's id is only ever reused within its own tenant) but relies on that rather than saying so.
    .leftJoin(U, and(eq(U.id, AP.closedBy), eq(U.tenantId, AP.tenantId)))
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
 * Refuses a period that has not ended yet in the tenant's own zone (fix round 1, item 1): closing a
 * month that is still running cannot be meaningful — every posting still to come in it would silently
 * miss the snapshot, with no "late arrival" mechanism to ever surface it, since it would still be
 * dated inside the very month the snapshot claims to be complete for.
 *
 * The window is the period's own calendar month, expressed the same way every other window in this
 * product is — `YYYY-MM-DD` civil-day strings, `to` exclusive — so it goes through the exact same
 * `buildJournalFor` → `resolveWindow` → `collectFrom` path the preview and the export use. `period`
 * is already `YYYY-MM` (the route's `periodStr` param validates that), so its first day and the next
 * period's first day are plain string concatenation; no need to round-trip through `periodStartDate`
 * for the window itself, since `buildJournalFor` resolves the civil day to an instant in the tenant's
 * own zone, the one place that's allowed to — `periodStartDate` is only needed below, to compare the
 * period's end against *now*, which `buildJournalFor` has no reason to know.
 */
export async function closeAccountingPeriod(db: Db, ctx: TenantContext, period: string, log: Log) {
  return db.transaction(async (tx) => {
    const { tenant } = await tenantPack(tx, ctx);
    if (periodStartDate(nextPeriod(period), tenant.timezone).getTime() > Date.now()) {
      throw badRequest('period_not_ended', `${period} has not ended yet`);
    }
    const { journal } = await buildJournalFor(tx, ctx, { from: `${period}-01`, to: `${nextPeriod(period)}-01` }, log);
    // Locked so two concurrent closes of the same period serialize on the row itself, not just on the
    // unique index: the second to run sees the first's committed row as `before` rather than the
    // `null` it would have read from an earlier, unlocked snapshot (fix round 1, item 3) — which
    // otherwise audited its own overwrite as a create.
    const [before] = await tx.select().from(AP).where(and(eq(AP.tenantId, ctx.tenantId), eq(AP.period, period))).for('update').limit(1);
    const values = {
      closedAt: new Date(), closedBy: ctx.userId,
      debitTotalMinor: journal.totals.debitMinor, creditTotalMinor: journal.totals.creditMinor,
      // The journal's own entries, not the corrections beside them — the column is labelled `Ставки`
      // on the periods table and must mean what `README.txt` means by it (fix round 2, item 5).
      entryCount: journalCounts(journal).entryCount,
    };
    // The unique index on (tenantId, period) makes this atomic: two concurrent closes of the same
    // period serialize on it rather than racing a read-then-insert into a duplicate row, and whichever
    // commits second simply rewrites the totals the first one wrote, same as a deliberate re-close.
    const [row] = await tx.insert(AP).values({ tenantId: ctx.tenantId, period, ...values })
      .onConflictDoUpdate({ target: [AP.tenantId, AP.period], set: { ...values, updatedAt: new Date() } }).returning();
    await writeAudit(tx, ctx, { action: 'accounting.period_close', entityType: 'accounting_period', entityId: row!.id, before: before ?? null, after: row });
    // The route needs `closedByName` too; looked up here, against the one user who just closed it,
    // rather than by re-listing every period for the tenant and finding this one back by id (fix
    // round 1, item 8) — which cost a full table scan for one name and, worse, could come back
    // `undefined` (a 500) if a concurrent reopen deleted the row between the write and the re-read.
    const closer = ctx.userId ? await tx.query.users.findFirst({ where: eq(U.id, ctx.userId), columns: { firstName: true, lastName: true } }) : undefined;
    return { ...row!, closedByName: closer ? `${closer.firstName} ${closer.lastName}`.trim() : null };
  });
}

export async function reopenAccountingPeriod(db: Db, ctx: TenantContext, period: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [before] = await tx.delete(AP).where(and(eq(AP.tenantId, ctx.tenantId), eq(AP.period, period))).returning();
    if (!before) throw notFound('Accounting period');
    await writeAudit(tx, ctx, { action: 'accounting.period_reopen', entityType: 'accounting_period', entityId: before.id, before, after: null });
  });
}
