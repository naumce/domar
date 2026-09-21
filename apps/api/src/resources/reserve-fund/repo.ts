import { type Db, schema } from '@domar/db';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import { writeAudit } from '../../audit.js';
import { conflict, notFound } from '../../errors.js';
import { addPosting, billedToOwners, fundBalance } from '../../ledger.js';
import type { TenantContext } from '../../tenant-context.js';
import { getBuilding } from '../buildings/repo.js';
import type { unitKindEnum } from '../common.js';
import type { expenseCreate, openingBalanceBody, settingPut } from './schema.js';

const RF = schema.reserveFundSettings;
const E = schema.expenses;
const P = schema.postings;

type UnitKind = z.infer<typeof unitKindEnum>;
type SettingRow = typeof RF.$inferSelect;
type SettingOut = Omit<SettingRow, 'appliesTo'> & { appliesTo: UnitKind[] };

function toSettingOut(row: SettingRow): SettingOut;
function toSettingOut(row: SettingRow | null): SettingOut | null;
function toSettingOut(row: SettingRow | null): SettingOut | null {
  return row ? { ...row, appliesTo: row.appliesTo as UnitKind[] } : null;
}

export async function getReserveFundState(db: Db, ctx: TenantContext, buildingId: string) {
  await getBuilding(db, ctx, buildingId);
  const setting = (await db.query.reserveFundSettings.findFirst({ where: and(eq(RF.tenantId, ctx.tenantId), eq(RF.buildingId, buildingId)) })) ?? null;
  const [balanceMinor, contributionsBilledMinor] = await Promise.all([fundBalance(db, ctx, buildingId, 'reserve'), billedToOwners(db, ctx, buildingId, 'reserve')]);
  return { setting: toSettingOut(setting), balanceMinor, contributionsBilledMinor };
}

export async function getReserveFundSetting(db: Db, ctx: TenantContext, buildingId: string) {
  return (await db.query.reserveFundSettings.findFirst({ where: and(eq(RF.tenantId, ctx.tenantId), eq(RF.buildingId, buildingId)) })) ?? null;
}

export async function putReserveFundSetting(db: Db, ctx: TenantContext, buildingId: string, input: z.infer<typeof settingPut>) {
  return db.transaction(async (tx) => {
    await getBuilding(tx, ctx, buildingId);
    const before = await getReserveFundSetting(tx, ctx, buildingId);
    const [row] = await tx.insert(RF).values({ tenantId: ctx.tenantId, buildingId, ...input })
      .onConflictDoUpdate({ target: RF.buildingId, set: { ...input, updatedAt: new Date() } }).returning();
    await writeAudit(tx, ctx, { action: 'reserve_fund.upsert', entityType: 'reserve_fund_setting', entityId: row!.id, before, after: row });
    return getReserveFundState(tx, ctx, buildingId);
  });
}

export async function addOpeningBalance(db: Db, ctx: TenantContext, buildingId: string, input: z.infer<typeof openingBalanceBody>) {
  return db.transaction(async (tx) => {
    await getBuilding(tx, ctx, buildingId);
    const posting = await addPosting(tx, ctx, { buildingId, account: 'fund', fund: 'reserve', kind: 'opening', amountMinor: input.amountMinor, refType: 'opening_balance' });
    await writeAudit(tx, ctx, { action: 'reserve_fund.opening_balance', entityType: 'posting', entityId: posting.id, after: { ...posting, note: input.note ?? null } });
    return posting;
  });
}

export async function listTransactions(db: Db, ctx: TenantContext, buildingId: string) {
  await getBuilding(db, ctx, buildingId);
  const rows = await db.select({ p: P, description: E.description }).from(P).leftJoin(E, and(eq(E.id, P.refId), inArray(P.refType, ['expense', 'expense_void'])))
    .where(and(eq(P.tenantId, ctx.tenantId), eq(P.buildingId, buildingId), eq(P.account, 'fund'), eq(P.fund, 'reserve'))).orderBy(desc(P.bookedAt), desc(P.createdAt));
  return { rows: rows.map((r) => ({ id: r.p.id, kind: r.p.kind, fund: r.p.fund, amountMinor: r.p.amountMinor, refType: r.p.refType, refId: r.p.refId, bookedAt: r.p.bookedAt, description: r.description ?? null })) };
}

export async function listExpenses(db: Db, ctx: TenantContext, buildingId: string) {
  await getBuilding(db, ctx, buildingId);
  const rows = await db.query.expenses.findMany({ where: and(eq(E.tenantId, ctx.tenantId), eq(E.buildingId, buildingId)), orderBy: (e, { desc: d }) => [d(e.paidAt), d(e.createdAt)] });
  return { rows };
}

export async function createExpense(db: Db, ctx: TenantContext, buildingId: string, input: z.infer<typeof expenseCreate>) {
  return db.transaction(async (tx) => {
    await getBuilding(tx, ctx, buildingId);
    const paidAt = new Date(input.paidAt);
    const [row] = await tx.insert(E).values({ tenantId: ctx.tenantId, buildingId, fund: input.fund, description: input.description, supplierText: input.supplierText ?? null, amountMinor: input.amountMinor, paidAt }).returning();
    await addPosting(tx, ctx, { buildingId, account: 'fund', fund: input.fund, kind: 'expense', amountMinor: -input.amountMinor, refType: 'expense', refId: row!.id, bookedAt: paidAt });
    await writeAudit(tx, ctx, { action: 'expense.create', entityType: 'expense', entityId: row!.id, after: row });
    return row!;
  });
}

export async function voidExpense(db: Db, ctx: TenantContext, buildingId: string, id: string, reason: string) {
  return db.transaction(async (tx) => {
    const before = await tx.query.expenses.findFirst({ where: and(eq(E.tenantId, ctx.tenantId), eq(E.buildingId, buildingId), eq(E.id, id)) });
    if (!before) throw notFound('Expense');
    const [row] = await tx.update(E).set({ voidedAt: new Date(), voidReason: reason, updatedAt: new Date() })
      .where(and(eq(E.tenantId, ctx.tenantId), eq(E.id, id), isNull(E.voidedAt))).returning();
    if (!row) throw conflict('already_voided', 'Expense is already voided');
    await addPosting(tx, ctx, { buildingId, account: 'fund', fund: before.fund, kind: 'adjustment', amountMinor: before.amountMinor, refType: 'expense_void', refId: id });
    await writeAudit(tx, ctx, { action: 'expense.void', entityType: 'expense', entityId: id, before, after: row });
    return row!;
  });
}
