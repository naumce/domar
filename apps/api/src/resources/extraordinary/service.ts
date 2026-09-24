import { type Db, schema } from '@domar/db';
import { nextPeriod } from '@domar/domain';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { badRequest, conflict } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { getBuilding } from '../buildings/repo.js';
import { assertDocumentInTenant } from '../documents/repo.js';
import { generatePeriod } from '../invoicing/generate.js';
import { publishPeriod } from '../invoicing/publish.js';
import type { ExtraordinaryCostCreate } from './schema.js';

const BP = schema.billingPeriods; const PL = schema.periodLines; const INV = schema.invoices; const U = schema.units; const T = schema.tenants;

type UnitRow = typeof U.$inferSelect;

/**
 * Plan addendum 17: the one line is always `shared_total`, and the *basis* the engine splits by is
 * the period's `distribution_basis`. `share` means the unit's own ownership share, which the engine
 * calls `custom`.
 */
const BASIS = { share: 'custom', equal: 'equal', area: 'area' } as const;

/** `YYYY-MM` as observed in the tenant's zone — the same expression the dashboard uses. */
function formatPeriod(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).format(d);
}

/**
 * This month, unless the building's *regular* period for it is already published — an owner should
 * not receive a charge dated to a month they have been invoiced and may already have paid for.
 */
export async function extraordinaryPeriodFor(db: Db, ctx: TenantContext, buildingId: string, timeZone: string, now: Date): Promise<string> {
  const current = formatPeriod(now, timeZone);
  const [regular] = await db.select({ status: BP.status }).from(BP)
    .where(and(eq(BP.tenantId, ctx.tenantId), eq(BP.buildingId, buildingId), eq(BP.period, current), eq(BP.kind, 'regular'))).limit(1);
  return regular?.status === 'published' ? nextPeriod(current) : current;
}

/** The owner a unit's charges land on, resolved exactly as the engine's `billingOwner` does. */
function billingOwnerOf(unit: UnitRow, byId: Map<string, UnitRow>): string | null {
  if (unit.attachedToUnitId) {
    const target = byId.get(unit.attachedToUnitId);
    if (target) return target.ownerContactId;
  }
  return unit.ownerContactId;
}

/**
 * Everything that would make the split quietly wrong, refused before a single row is written.
 *
 * The engine is forgiving by design: a covered unit with no owner, no share or no area gets its
 * slice computed and then dropped or given weight 0, which spreads that slice over its neighbours
 * or simply loses it. For a one-off charge under Art. 47(5) that is a silent misbill, so each case
 * is a 400 naming the units the manager has to fix first.
 */
async function assertDistributable(db: Db, ctx: TenantContext, buildingId: string, input: ExtraordinaryCostCreate): Promise<void> {
  const units = await db.query.units.findMany({
    where: and(eq(U.tenantId, ctx.tenantId), eq(U.buildingId, buildingId)),
    orderBy: (u, { asc: a }) => [a(u.floor), a(u.label)],
  });
  const applies = input.appliesTo ?? [];
  const covered = units.filter((u) => applies.length === 0 || applies.includes(u.kind));
  if (covered.length === 0) throw badRequest('no_units', 'This distribution reaches no unit; check appliesTo');

  const byId = new Map(units.map((u) => [u.id, u]));
  const ownerless = covered.filter((u) => billingOwnerOf(u, byId) === null).map((u) => u.label);
  if (ownerless.length > 0) {
    throw badRequest('missing_owner', `Every unit in this distribution needs an owner; these have none: ${ownerless.join(', ')}`, { units: ownerless });
  }

  if (input.distribution === 'equal') return;
  const field = input.distribution === 'share' ? 'ownershipShare' : 'areaM2';
  const missing = covered.filter((u) => (field === 'ownershipShare' ? u.ownershipShare : u.areaM2) === null).map((u) => u.label);
  if (missing.length > 0) {
    throw badRequest('missing_unit_data', `A '${input.distribution}' distribution needs ${field} on every covered unit; these have none: ${missing.join(', ')}`, { field, units: missing });
  }
}

/**
 * An unfinished extraordinary period is in the manager's way: its draft invoices are part of the
 * building's numbers and the next distribution would run beside it. Refuse, and name it, so the
 * manager publishes it or deletes it (`DELETE /buildings/:id/periods/:periodId`) first.
 */
async function assertNothingPending(db: Db, ctx: TenantContext, buildingId: string): Promise<void> {
  const [pending] = await db.select({ id: BP.id, status: BP.status }).from(BP)
    .where(and(eq(BP.tenantId, ctx.tenantId), eq(BP.buildingId, buildingId), eq(BP.kind, 'extraordinary'), inArray(BP.status, ['open', 'generated'])))
    .orderBy(asc(BP.createdAt)).limit(1);
  if (pending) {
    throw conflict('extraordinary_pending', 'An earlier extraordinary cost is still unpublished; publish or delete it first', { periodId: pending.id, status: pending.status });
  }
}

/**
 * Three steps, each with its own transaction (plan addendum 19): create the period and its single
 * line, generate through the existing engine, then publish through the existing service — so the
 * ledger, the numbering, the legal event and the reminder rules all behave exactly as they do for a
 * regular month. Everything that could make the split wrong is refused before step one, and a
 * generate that produces nothing rolls the period back, so no half-finished period is left behind.
 */
export async function distributeExtraordinaryCost(db: Db, ctx: TenantContext, buildingId: string, input: ExtraordinaryCostCreate, now: Date = new Date()) {
  await getBuilding(db, ctx, buildingId); // 404 across tenants
  const tenant = (await db.query.tenants.findFirst({ where: eq(T.id, ctx.tenantId) }))!;
  await assertNothingPending(db, ctx, buildingId);
  await assertDistributable(db, ctx, buildingId, input);
  const period = await extraordinaryPeriodFor(db, ctx, buildingId, tenant.timezone, now);

  const created = await db.transaction(async (tx) => {
    await assertDocumentInTenant(tx, ctx, input.documentId);
    const [row] = await tx.insert(BP).values({
      tenantId: ctx.tenantId, buildingId, period, kind: 'extraordinary',
      distributionBasis: BASIS[input.distribution], currency: tenant.currency,
      managementFeeMinor: 0, managementFeeAppliesTo: [],
    }).returning();
    await tx.insert(PL).values({
      tenantId: ctx.tenantId, periodId: row!.id, serviceId: null, description: input.description,
      pricing: 'shared_total', quantity: '1', unitPriceMinor: input.amountMinor, taxRateBp: 0,
      appliesTo: input.appliesTo ?? [], fund: input.fund, source: 'manual', sortOrder: 0,
      note: 'Вонреден трошок (чл. 47(5))',
    });
    await writeAudit(tx, ctx, {
      action: 'extraordinary_cost.create', entityType: 'billing_period', entityId: row!.id,
      after: { ...row!, amountMinor: input.amountMinor, distribution: input.distribution, fund: input.fund, documentId: input.documentId ?? null },
    });
    return row!;
  });

  const generated = await generatePeriod(db, ctx, buildingId, created.id);
  if (generated.invoiceCount === 0) {
    // Nothing to publish: undo the empty period rather than leaving it for the manager to find.
    await db.transaction(async (tx) => {
      await tx.delete(BP).where(and(eq(BP.tenantId, ctx.tenantId), eq(BP.id, created.id)));
      await writeAudit(tx, ctx, { action: 'extraordinary_cost.discard', entityType: 'billing_period', entityId: created.id, before: created });
    });
    const noWeight = generated.warnings.some((w) => (w as { code?: string }).code === 'no_weight');
    throw noWeight
      ? badRequest('no_weight', 'No unit carries weight for this basis; check the unit shares or areas')
      : badRequest('no_units', 'This distribution reaches no unit with an owner; check appliesTo and the unit shares');
  }

  const published = await publishPeriod(db, ctx, buildingId, created.id, { dueDays: input.dueDays, documentId: input.documentId ?? null });
  const invoices = await db.select({ id: INV.id }).from(INV)
    .where(and(eq(INV.tenantId, ctx.tenantId), eq(INV.periodId, created.id))).orderBy(asc(INV.id));

  return { periodId: created.id, period, invoiceCount: published.invoiceCount, totalMinor: published.totalMinor, invoiceIds: invoices.map((i) => i.id) };
}
