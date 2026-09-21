import { type Db, schema } from '@domar/db';
import { calculatePeriod, type CalcInput, type CalcLine, type UnitKind } from '@domar/domain';
import { and, eq, inArray } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { conflict } from '../../errors.js';
import { fundBalance, ownerBalances } from '../../ledger.js';
import type { TenantContext } from '../../tenant-context.js';
import { getBuilding } from '../buildings/repo.js';
import { getPeriod, getPeriodRow } from '../periods/repo.js';
import { getReserveFundSetting } from '../reserve-fund/repo.js';

const INV = schema.invoices; const IL = schema.invoiceLines;

export async function buildCalcInput(db: Db, ctx: TenantContext, buildingId: string, periodId: string): Promise<CalcInput> {
  const building = await getBuilding(db, ctx, buildingId);
  const period = await getPeriod(db, ctx, buildingId, periodId);
  const units = await db.query.units.findMany({ where: and(eq(schema.units.tenantId, ctx.tenantId), eq(schema.units.buildingId, buildingId)), orderBy: (u, { asc }) => [asc(u.floor), asc(u.label)] });
  const lines: CalcLine[] = period.lines.map((l) => ({
    id: l.id, kind: l.serviceId ? 'service' : 'manual', description: l.description, pricing: l.pricing, quantity: l.quantity,
    unitPriceMinor: l.unitPriceMinor, taxRateBp: l.taxRateBp, appliesTo: l.appliesTo as UnitKind[], fund: l.fund,
  }));
  const rf = await getReserveFundSetting(db, ctx, buildingId);
  if (rf?.active && rf.amountMinor > 0) {
    lines.push({ id: `reserve-fund:${rf.id}`, kind: 'reserve_fund', description: 'Резервен фонд', pricing: rf.basis === 'per_m2' ? 'per_m2' : 'fixed_per_unit', quantity: 1, unitPriceMinor: rf.amountMinor, taxRateBp: 0, appliesTo: rf.appliesTo as UnitKind[], fund: 'reserve' });
  }
  if (period.managementFeeMinor > 0) {
    lines.push({ id: `management-fee:${period.id}`, kind: 'management_fee', description: 'Управувачки услуги', pricing: 'fixed_per_unit', quantity: 1, unitPriceMinor: period.managementFeeMinor, taxRateBp: period.managementFeeTaxRateBp, appliesTo: period.managementFeeAppliesTo as UnitKind[], fund: 'regular' });
  }
  return {
    building: { id: building.id, shareBasis: building.shareBasis },
    units: units.map((u) => ({ id: u.id, label: u.label, kind: u.kind, areaM2: u.areaM2 === null ? null : Number(u.areaM2), ownershipShare: u.ownershipShare === null ? null : Number(u.ownershipShare), ownerContactId: u.ownerContactId, attachedToUnitId: u.attachedToUnitId })),
    lines,
    previousBalances: await ownerBalances(db, ctx, buildingId),
    reserveFundBuildingBalanceMinor: await fundBalance(db, ctx, buildingId, 'reserve'),
  };
}

async function deleteDraftInvoices(db: Db, ctx: TenantContext, periodId: string) {
  const drafts = await db.select({ id: INV.id }).from(INV).where(and(eq(INV.tenantId, ctx.tenantId), eq(INV.periodId, periodId), eq(INV.status, 'draft')));
  if (drafts.length) await db.delete(INV).where(inArray(INV.id, drafts.map((d) => d.id))); // cascades invoice_lines
  return drafts.length;
}

export async function generatePeriod(db: Db, ctx: TenantContext, buildingId: string, periodId: string) {
  return db.transaction(async (tx) => {
    // Claim the row first: this locks it for the duration of the transaction, so a concurrent
    // generate on the same period serializes behind us instead of racing on the delete+insert below.
    const [claimed] = await tx.update(schema.billingPeriods).set({ updatedAt: new Date() })
      .where(and(eq(schema.billingPeriods.tenantId, ctx.tenantId), eq(schema.billingPeriods.buildingId, buildingId), eq(schema.billingPeriods.id, periodId), inArray(schema.billingPeriods.status, ['open', 'generated'])))
      .returning();
    if (!claimed) {
      await getPeriodRow(tx, ctx, buildingId, periodId); // 404 if the period doesn't exist for this tenant/building
      throw conflict('period_locked', 'A published period cannot be regenerated');
    }
    const input = await buildCalcInput(tx, ctx, buildingId, periodId);
    const result = calculatePeriod(input);
    await deleteDraftInvoices(tx, ctx, periodId);
    const lineIdIsPeriodLine = new Set(input.lines.filter((l) => l.kind === 'service' || l.kind === 'manual').map((l) => l.id));
    for (const draft of result.invoices) {
      const [inv] = await tx.insert(INV).values({
        tenantId: ctx.tenantId, periodId, buildingId, contactId: draft.contactId, status: 'draft', currency: claimed.currency, unitIds: draft.unitIds,
        subtotalMinor: draft.subtotalMinor, taxMinor: draft.taxMinor, totalMinor: draft.totalMinor, previousBalanceMinor: draft.previousBalanceMinor,
        amountDueMinor: draft.amountDueMinor, reserveFundBuildingBalanceMinor: draft.reserveFundBuildingBalanceMinor,
      }).returning({ id: INV.id });
      await tx.insert(IL).values(draft.lines.map((l, i) => ({
        tenantId: ctx.tenantId, invoiceId: inv!.id, periodLineId: lineIdIsPeriodLine.has(l.lineId) ? l.lineId : null, kind: l.kind, description: l.description, fund: l.fund,
        unitId: l.unitId, unitLabel: l.unitLabel, buildingWideNetMinor: l.buildingWideNetMinor, ownerNetMinor: l.ownerNetMinor, taxRateBp: l.taxRateBp,
        ownerTaxMinor: l.ownerTaxMinor, ownerGrossMinor: l.ownerGrossMinor, sortOrder: i,
      })));
    }
    await tx.update(schema.billingPeriods).set({ status: 'generated', generatedAt: new Date(), warnings: result.warnings, updatedAt: new Date() }).where(eq(schema.billingPeriods.id, periodId));
    await writeAudit(tx, ctx, { action: 'period.generate', entityType: 'billing_period', entityId: periodId, after: { invoiceCount: result.invoices.length, warnings: result.warnings } });
    const detail = await getPeriod(tx, ctx, buildingId, periodId);
    return { period: detail, invoiceCount: detail.invoiceCount, totalMinor: detail.totalMinor, warnings: result.warnings, skippedUnits: result.skippedUnits };
  });
}

export async function deleteDrafts(db: Db, ctx: TenantContext, buildingId: string, periodId: string) {
  return db.transaction(async (tx) => {
    const period = await getPeriodRow(tx, ctx, buildingId, periodId);
    if (period.status === 'published') throw conflict('period_locked', 'A published period has no drafts');
    const n = await deleteDraftInvoices(tx, ctx, periodId);
    await tx.update(schema.billingPeriods).set({ status: 'open', generatedAt: null, warnings: [], updatedAt: new Date() }).where(eq(schema.billingPeriods.id, periodId));
    await writeAudit(tx, ctx, { action: 'period.delete_drafts', entityType: 'billing_period', entityId: periodId, after: { deleted: n } });
    return getPeriod(tx, ctx, buildingId, periodId);
  });
}
