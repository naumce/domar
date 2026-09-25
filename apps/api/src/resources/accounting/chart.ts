import { type Db, schema } from '@domar/db';
import { type AccountSlot, type Chart, chartFrom, missingSlots } from '@domar/domain';
import { and, asc, eq } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { AppError, badRequest } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import type { AccountCodePut } from './schema.js';

const AC = schema.accountCodes;
export type AccountCodeRow = typeof AC.$inferSelect;

/** Why a slot in `requireChart`'s 409 can't be used yet: no row at all, a row switched off, or a row with a blank code. */
export type MissingReason = 'absent' | 'inactive' | 'blank_code';
export interface MissingSlotDetail { slot: AccountSlot; reason: MissingReason }

/** The tenant's chart, the slots it still has to map, and the derivation's view of it when complete. */
export async function loadChart(db: Db, ctx: TenantContext): Promise<{ rows: AccountCodeRow[]; missing: AccountSlot[]; chart: Chart | null }> {
  const rows = await db.select().from(AC).where(eq(AC.tenantId, ctx.tenantId)).orderBy(asc(AC.slot));
  const missing = missingSlots(rows);
  return { rows, missing, chart: missing.length === 0 ? chartFrom(rows) : null };
}

/**
 * Spec §3: the export refuses to run while a required slot is unmapped, and names every one of them.
 * 409 rather than 400 — the request is well formed, the organization is not ready to answer it.
 *
 * Each unusable slot also carries *why*: a mapping that is configured but disabled must not be
 * reported the same way as one nobody has entered a code for, or the fix is to re-enter a code
 * that is already there and the caller stays stuck.
 */
export async function requireChart(db: Db, ctx: TenantContext): Promise<Chart> {
  const { rows, missing, chart } = await loadChart(db, ctx);
  if (!chart) {
    const bySlot = new Map(rows.map((r) => [r.slot, r]));
    const details: MissingSlotDetail[] = missing.map((slot) => {
      const row = bySlot.get(slot);
      const reason: MissingReason = !row ? 'absent' : !row.isActive ? 'inactive' : 'blank_code';
      return { slot, reason };
    });
    throw new AppError(409, 'chart_incomplete', `Unmapped account slots: ${missing.join(', ')}`, { missing: details });
  }
  return chart;
}

/** One row per slot per tenant: a second PUT rewrites the first rather than adding a rival code. */
export async function putAccountCode(db: Db, ctx: TenantContext, slot: AccountSlot, input: AccountCodePut): Promise<AccountCodeRow> {
  return db.transaction(async (tx) => {
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
