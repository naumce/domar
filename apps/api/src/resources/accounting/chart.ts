import { type Db, schema } from '@domar/db';
import { type AccountSlot, type Chart, chartFrom, missingSlots } from '@domar/domain';
import { and, asc, eq, ne } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { AppError, badRequest, conflict } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import type { AccountCodePut } from './schema.js';

const AC = schema.accountCodes;
export type AccountCodeRow = typeof AC.$inferSelect;

/** Why a slot can't be used yet: no row at all, a row switched off, or a row with a blank code. */
export type MissingReason = 'absent' | 'inactive' | 'blank_code';
export interface MissingSlotDetail { slot: AccountSlot; reason: MissingReason }

/**
 * The one classifier for "why is this slot unusable" — shared by the chart list (`GET
 * /api/account-codes`) and the 409 `requireChart` throws, so the two never drift into disagreeing
 * about the same slot. A mapping that is configured but disabled must not be reported the same way
 * as one nobody has entered a code for, or the fix is to re-enter a code that is already there and
 * the caller stays stuck.
 */
function classifyMissing(rows: AccountCodeRow[], missing: AccountSlot[]): MissingSlotDetail[] {
  const bySlot = new Map(rows.map((r) => [r.slot, r]));
  return missing.map((slot) => {
    const row = bySlot.get(slot);
    const reason: MissingReason = !row ? 'absent' : !row.isActive ? 'inactive' : 'blank_code';
    return { slot, reason };
  });
}

/** The tenant's chart, the slots it still has to map (with why), and the derivation's view of it
 * when complete. */
export async function loadChart(db: Db, ctx: TenantContext): Promise<{ rows: AccountCodeRow[]; missing: MissingSlotDetail[]; chart: Chart | null }> {
  const rows = await db.select().from(AC).where(eq(AC.tenantId, ctx.tenantId)).orderBy(asc(AC.slot));
  const missingSlotList = missingSlots(rows);
  return { rows, missing: classifyMissing(rows, missingSlotList), chart: missingSlotList.length === 0 ? chartFrom(rows) : null };
}

/**
 * Spec §3: the export refuses to run while a required slot is unmapped, and names every one of them.
 * 409 rather than 400 — the request is well formed, the organization is not ready to answer it.
 */
export async function requireChart(db: Db, ctx: TenantContext): Promise<Chart> {
  const { missing, chart } = await loadChart(db, ctx);
  if (!chart) {
    throw new AppError(409, 'chart_incomplete', `Unmapped account slots: ${missing.map((m) => m.slot).join(', ')}`, { missing });
  }
  return chart;
}

/**
 * One row per slot per tenant: a second PUT rewrites the first rather than adding a rival code.
 *
 * Two slots may not share a code. `buildJournal` refuses one as well, because the chart it reads can
 * come from rows written before this check existed — but refusing it here is what a user can act on:
 * the two sides of an entry landing on one code net to nothing and the movement disappears from a
 * file that still balances.
 */
export async function putAccountCode(db: Db, ctx: TenantContext, slot: AccountSlot, input: AccountCodePut): Promise<AccountCodeRow> {
  return db.transaction(async (tx) => {
    const [taken] = await tx.select({ slot: AC.slot }).from(AC)
      .where(and(eq(AC.tenantId, ctx.tenantId), eq(AC.code, input.code), ne(AC.slot, slot))).limit(1);
    if (taken) {
      throw conflict('duplicate_account_code', `account code ${input.code} is already mapped to ${taken.slot}`, { code: input.code, slot: taken.slot });
    }
    const [before] = await tx.select().from(AC).where(and(eq(AC.tenantId, ctx.tenantId), eq(AC.slot, slot))).limit(1);
    const values = { code: input.code, name: input.name, ...(input.isActive === undefined ? {} : { isActive: input.isActive }) };
    // A unique index on (tenantId, slot) backs this: two concurrent PUTs to the same slot both
    // upsert against it rather than racing a read-then-insert into a duplicate row.
    const [row] = await tx.insert(AC).values({ tenantId: ctx.tenantId, slot, ...values })
      .onConflictDoUpdate({ target: [AC.tenantId, AC.slot], set: { ...values, updatedAt: new Date() } }).returning();
    await writeAudit(tx, ctx, { action: 'account_code.put', entityType: 'account_code', entityId: row!.id, before: before ?? null, after: row });
    return row!;
  });
}

/** A code of another tenant is not a 403 but a bad reference: the caller must not learn it exists. */
export async function assertAccountCodeInTenant(db: Db, ctx: TenantContext, id: string | null | undefined): Promise<void> {
  if (!id) return;
  const [row] = await db.select({ id: AC.id }).from(AC).where(and(eq(AC.tenantId, ctx.tenantId), eq(AC.id, id))).limit(1);
  if (!row) throw badRequest('invalid_reference', 'accountCodeId does not belong to this organization');
}
