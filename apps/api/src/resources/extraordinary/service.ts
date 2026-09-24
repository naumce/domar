import { type Db, schema } from '@domar/db';
import { nextPeriod } from '@domar/domain';
import { and, asc, eq } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { badRequest } from '../../errors.js';
import { recordLegalEvent } from '../../legal-events.js';
import type { TenantContext } from '../../tenant-context.js';
import { getBuilding } from '../buildings/repo.js';
import { assertDocumentInTenant } from '../documents/repo.js';
import { generatePeriod } from '../invoicing/generate.js';
import { publishPeriod } from '../invoicing/publish.js';
import type { ExtraordinaryCostCreate } from './schema.js';

const BP = schema.billingPeriods; const PL = schema.periodLines; const INV = schema.invoices; const U = schema.units; const T = schema.tenants;

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

/**
 * A `share` split needs every covered unit's ownership share and an `area` split needs its area.
 * Without them the engine gives the unit weight 0 and quietly spreads its part of the cost over its
 * neighbours, so refuse before anything is created and name the units the manager has to fix.
 */
async function assertUnitsCarryTheBasis(db: Db, ctx: TenantContext, buildingId: string, input: ExtraordinaryCostCreate): Promise<void> {
  if (input.distribution === 'equal') return;
  const field = input.distribution === 'share' ? 'ownershipShare' : 'areaM2';
  const units = await db.query.units.findMany({
    where: and(eq(U.tenantId, ctx.tenantId), eq(U.buildingId, buildingId)),
    orderBy: (u, { asc: a }) => [a(u.floor), a(u.label)],
  });
  const applies = input.appliesTo ?? [];
  const missing = units
    .filter((u) => applies.length === 0 || applies.includes(u.kind))
    .filter((u) => (field === 'ownershipShare' ? u.ownershipShare : u.areaM2) === null)
    .map((u) => u.label);
  if (missing.length > 0) {
    throw badRequest('missing_unit_data', `A '${input.distribution}' distribution needs ${field} on every covered unit; these have none: ${missing.join(', ')}`, { field, units: missing });
  }
}

/**
 * Four steps, each with its own transaction (plan addendum 19): create the period and its single
 * line, generate through the existing engine, publish through the existing service — so the ledger,
 * the numbering and the reminder rules all behave exactly as they do for a regular month — and then
 * record the legal event with the invoice ids the publish produced.
 */
export async function distributeExtraordinaryCost(db: Db, ctx: TenantContext, buildingId: string, input: ExtraordinaryCostCreate) {
  await getBuilding(db, ctx, buildingId); // 404 across tenants
  const tenant = (await db.query.tenants.findFirst({ where: eq(T.id, ctx.tenantId) }))!;
  const now = new Date();
  await assertUnitsCarryTheBasis(db, ctx, buildingId, input);
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
    throw badRequest('no_units', 'This distribution reaches no unit with an owner; check appliesTo and the unit shares');
  }

  const dueAt = new Date(now.getTime() + input.dueDays * 86_400_000);
  const published = await publishPeriod(db, ctx, buildingId, created.id, { dueAt });
  const invoices = await db.select({ id: INV.id }).from(INV)
    .where(and(eq(INV.tenantId, ctx.tenantId), eq(INV.periodId, created.id))).orderBy(asc(INV.id));
  const invoiceIds = invoices.map((i) => i.id);

  await db.transaction(async (tx) => {
    await recordLegalEvent(tx, ctx, {
      buildingId, kind: 'extraordinary_cost_distributed', refType: 'billing_period', refId: created.id,
      occurredAt: now, dueAt,
      evidence: {
        periodId: created.id, period, amountMinor: input.amountMinor, fund: input.fund,
        distribution: input.distribution, appliesTo: input.appliesTo ?? [],
        invoiceIds, invoiceCount: invoiceIds.length, documentId: input.documentId ?? null,
      },
    });
  });

  return { periodId: created.id, period, invoiceCount: published.invoiceCount, totalMinor: published.totalMinor, invoiceIds };
}
