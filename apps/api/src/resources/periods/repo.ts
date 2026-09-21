import { type Db, schema } from '@domar/db';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { writeAudit } from '../../audit.js';
import { badRequest, conflict, isUniqueViolation, notFound } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { getBuilding } from '../buildings/repo.js';
import { stripUndefined } from '../common.js';
import type { unitKindEnum } from '../common.js';
import { resolveTaxRateBp } from '../services/repo.js';
import { buildAutoLines, type NewPeriodLine } from './auto-lines.js';
import type { LineCreate, LinePatch, PeriodCreate, PeriodPatch } from './schema.js';

const BP = schema.billingPeriods; const PL = schema.periodLines; const INV = schema.invoices;
type PeriodRow = typeof BP.$inferSelect;
type UnitKind = z.infer<typeof unitKindEnum>;

export function assertPeriodEditable(p: { status: string }) {
  if (p.status === 'published') throw conflict('period_locked', 'A published period cannot be changed');
}

type PeriodStatus = PeriodRow['status'];

/**
 * Claims the period row for the rest of the transaction: the conditional UPDATE takes a row lock,
 * so a concurrent writer serializes behind us and then re-reads the status it was allowed to see.
 */
export async function claimPeriod(tx: Db, ctx: TenantContext, buildingId: string, id: string, allowed: PeriodStatus[]): Promise<PeriodRow> {
  const [row] = await tx.update(BP).set({ updatedAt: new Date() })
    .where(and(eq(BP.tenantId, ctx.tenantId), eq(BP.buildingId, buildingId), eq(BP.id, id), inArray(BP.status, allowed)))
    .returning();
  if (!row) {
    await getPeriodRow(tx, ctx, buildingId, id); // 404 if the period doesn't exist for this tenant/building
    throw conflict('period_locked', 'A published period cannot be changed');
  }
  return row;
}

/** Deletes the period's draft invoices (invoice_lines cascade). Returns how many were removed. */
export async function deleteDraftInvoices(tx: Db, ctx: TenantContext, periodId: string): Promise<number> {
  const drafts = await tx.select({ id: INV.id }).from(INV).where(and(eq(INV.tenantId, ctx.tenantId), eq(INV.periodId, periodId), eq(INV.status, 'draft')));
  if (drafts.length) await tx.delete(INV).where(and(eq(INV.tenantId, ctx.tenantId), eq(INV.status, 'draft'), inArray(INV.id, drafts.map((d) => d.id))));
  return drafts.length;
}

/** Drops the drafts of a generated period and puts the period back to 'open'. Call on a claimed period. */
export async function resetDrafts(tx: Db, ctx: TenantContext, periodId: string): Promise<number> {
  const n = await deleteDraftInvoices(tx, ctx, periodId);
  await tx.update(BP).set({ status: 'open', generatedAt: null, warnings: [], updatedAt: new Date() }).where(and(eq(BP.tenantId, ctx.tenantId), eq(BP.id, periodId)));
  return n;
}

function toLine(l: typeof PL.$inferSelect) {
  return { ...l, quantity: Number(l.quantity), appliesTo: l.appliesTo as UnitKind[] };
}

function toPeriod<T extends PeriodRow>(row: T) {
  return { ...row, managementFeeAppliesTo: row.managementFeeAppliesTo as UnitKind[], warnings: row.warnings as Record<string, unknown>[] };
}

async function stats(db: Db, ctx: TenantContext, periodId: string) {
  const [r] = await db.select({ invoiceCount: count(), totalMinor: sql<string>`coalesce(sum(${INV.totalMinor}), 0)` }).from(INV).where(and(eq(INV.tenantId, ctx.tenantId), eq(INV.periodId, periodId)));
  return { invoiceCount: Number(r?.invoiceCount ?? 0), totalMinor: Number(r?.totalMinor ?? 0) };
}

export async function getPeriodRow(db: Db, ctx: TenantContext, buildingId: string, id: string): Promise<PeriodRow> {
  const row = await db.query.billingPeriods.findFirst({ where: and(eq(BP.tenantId, ctx.tenantId), eq(BP.buildingId, buildingId), eq(BP.id, id)) });
  if (!row) throw notFound('Billing period');
  return row;
}

export async function getPeriod(db: Db, ctx: TenantContext, buildingId: string, id: string) {
  const row = await getPeriodRow(db, ctx, buildingId, id);
  const lines = await db.query.periodLines.findMany({ where: and(eq(PL.tenantId, ctx.tenantId), eq(PL.periodId, id)), orderBy: [asc(PL.sortOrder), asc(PL.createdAt)] });
  return { ...toPeriod(row), ...(await stats(db, ctx, id)), lines: lines.map(toLine) };
}

export async function listPeriods(db: Db, ctx: TenantContext, buildingId: string) {
  await getBuilding(db, ctx, buildingId);
  // "billing_periods"."id" is hard-coded: drizzle renders single-table select columns unqualified
  // inside raw sql, so an unqualified `id` here would bind to the subquery's own `invoices.id`.
  const rows = await db.select({ p: BP, invoiceCount: sql<number>`(select count(*) from ${INV} i where i.period_id = "billing_periods"."id")`.mapWith(Number), totalMinor: sql<string>`(select coalesce(sum(i.total_minor),0) from ${INV} i where i.period_id = "billing_periods"."id")` })
    .from(BP).where(and(eq(BP.tenantId, ctx.tenantId), eq(BP.buildingId, buildingId))).orderBy(desc(BP.period));
  return { rows: rows.map((r) => ({ ...toPeriod(r.p), invoiceCount: r.invoiceCount, totalMinor: Number(r.totalMinor) })) };
}

async function insertLines(db: Db, ctx: TenantContext, periodId: string, lines: NewPeriodLine[]) {
  if (lines.length === 0) return;
  await db.insert(PL).values(lines.map((l) => ({ ...l, tenantId: ctx.tenantId, periodId })));
}

export async function createPeriod(db: Db, ctx: TenantContext, buildingId: string, input: PeriodCreate) {
  return db.transaction(async (tx) => {
    await getBuilding(tx, ctx, buildingId);
    const tenant = await tx.query.tenants.findFirst({ where: eq(schema.tenants.id, ctx.tenantId), columns: { currency: true } });
    const feeBp = (await resolveTaxRateBp(tx, ctx, input.managementFeeTaxRateId)) ?? 0;
    let row: PeriodRow | undefined;
    try {
      [row] = await tx.insert(BP).values({
        tenantId: ctx.tenantId, buildingId, period: input.period, currency: tenant!.currency,
        managementFeeMinor: input.managementFeeMinor ?? 0, managementFeeTaxRateBp: feeBp,
        ...(input.managementFeeAppliesTo ? { managementFeeAppliesTo: input.managementFeeAppliesTo } : {}),
      }).returning();
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('period_exists', `Period ${input.period} already exists for this building`);
      throw e;
    }
    await insertLines(tx, ctx, row!.id, await buildAutoLines(tx, ctx, buildingId, input.period));
    await writeAudit(tx, ctx, { action: 'period.create', entityType: 'billing_period', entityId: row!.id, after: row });
    return getPeriod(tx, ctx, buildingId, row!.id);
  });
}

export async function updatePeriod(db: Db, ctx: TenantContext, buildingId: string, id: string, patch: PeriodPatch) {
  return db.transaction(async (tx) => {
    const before = await claimPeriod(tx, ctx, buildingId, id, ['open', 'generated']);
    if (before.status === 'generated') await resetDrafts(tx, ctx, id);
    const { managementFeeTaxRateId, ...rest } = patch;
    const set: Partial<typeof BP.$inferInsert> = { ...stripUndefined(rest), updatedAt: new Date() };
    if (managementFeeTaxRateId !== undefined) set.managementFeeTaxRateBp = (await resolveTaxRateBp(tx, ctx, managementFeeTaxRateId)) ?? 0;
    const [row] = await tx.update(BP).set(set).where(and(eq(BP.tenantId, ctx.tenantId), eq(BP.id, id))).returning();
    await writeAudit(tx, ctx, { action: 'period.update', entityType: 'billing_period', entityId: id, before, after: row });
    return getPeriod(tx, ctx, buildingId, id);
  });
}

export async function refreshAutoLines(db: Db, ctx: TenantContext, buildingId: string, id: string) {
  return db.transaction(async (tx) => {
    const period = await claimPeriod(tx, ctx, buildingId, id, ['open', 'generated']);
    if (period.status === 'generated') await resetDrafts(tx, ctx, id);
    await tx.delete(PL).where(and(eq(PL.tenantId, ctx.tenantId), eq(PL.periodId, id), eq(PL.source, 'auto')));
    // A manual copy of a service (an edited auto line) wins: don't hand the period a second line for it.
    const kept = await tx.select({ serviceId: PL.serviceId }).from(PL).where(and(eq(PL.tenantId, ctx.tenantId), eq(PL.periodId, id)));
    const keptServiceIds = new Set(kept.map((l) => l.serviceId).filter((s): s is string => s !== null));
    const rebuilt = (await buildAutoLines(tx, ctx, buildingId, period.period)).filter((l) => l.serviceId === null || !keptServiceIds.has(l.serviceId));
    await insertLines(tx, ctx, id, rebuilt);
    await writeAudit(tx, ctx, { action: 'period.refresh_lines', entityType: 'billing_period', entityId: id });
    return getPeriod(tx, ctx, buildingId, id);
  });
}

export async function addLine(db: Db, ctx: TenantContext, buildingId: string, id: string, input: LineCreate) {
  return db.transaction(async (tx) => {
    const period = await claimPeriod(tx, ctx, buildingId, id, ['open', 'generated']);
    if (period.status === 'generated') await resetDrafts(tx, ctx, id);
    let base: Partial<NewPeriodLine> = {};
    if (input.serviceId) {
      const s = await tx.select({ s: schema.services, rateBp: schema.taxRates.rateBp }).from(schema.services).leftJoin(schema.taxRates, eq(schema.taxRates.id, schema.services.taxRateId))
        .where(and(eq(schema.services.tenantId, ctx.tenantId), eq(schema.services.id, input.serviceId), eq(schema.services.isActive, true))).limit(1);
      if (!s[0]) throw badRequest('invalid_reference', 'serviceId is not an active service of this organization');
      base = { serviceId: s[0].s.id, description: s[0].s.name, pricing: s[0].s.pricing, unitPriceMinor: s[0].s.defaultPriceMinor, taxRateBp: s[0].rateBp ?? 0, appliesTo: s[0].s.appliesTo };
    }
    const taxRateBp = input.taxRateId !== undefined ? ((await resolveTaxRateBp(tx, ctx, input.taxRateId)) ?? 0) : (base.taxRateBp ?? 0);
    const [maxRow] = await tx.select({ max: sql<number>`coalesce(max(${PL.sortOrder}), -10)`.mapWith(Number) }).from(PL).where(and(eq(PL.tenantId, ctx.tenantId), eq(PL.periodId, id)));
    const max = maxRow?.max;
    const line: NewPeriodLine = {
      serviceId: base.serviceId ?? null, description: input.description ?? base.description!, pricing: input.pricing ?? base.pricing!,
      quantity: String(input.quantity ?? 1), unitPriceMinor: input.unitPriceMinor ?? base.unitPriceMinor!, taxRateBp,
      appliesTo: input.appliesTo ?? base.appliesTo ?? [], fund: input.fund ?? 'regular', source: 'manual', note: input.note ?? null, sortOrder: (max ?? -10) + 10,
    };
    const [row] = await tx.insert(PL).values({ ...line, tenantId: ctx.tenantId, periodId: id }).returning();
    await writeAudit(tx, ctx, { action: 'period_line.create', entityType: 'period_line', entityId: row!.id, after: row });
    return toLine(row!);
  });
}

export async function updateLine(db: Db, ctx: TenantContext, buildingId: string, id: string, lineId: string, patch: LinePatch) {
  return db.transaction(async (tx) => {
    const period = await claimPeriod(tx, ctx, buildingId, id, ['open', 'generated']);
    if (period.status === 'generated') await resetDrafts(tx, ctx, id);
    const before = await tx.query.periodLines.findFirst({ where: and(eq(PL.tenantId, ctx.tenantId), eq(PL.periodId, id), eq(PL.id, lineId)) });
    if (!before) throw notFound('Period line');
    if (before.source === 'auto' && !patch.note) throw badRequest('note_required', 'Editing an automatic line requires a note');
    const { taxRateId, quantity, ...rest } = patch;
    const set: Partial<typeof PL.$inferInsert> = { ...stripUndefined(rest), source: 'manual', updatedAt: new Date() };
    if (quantity !== undefined) set.quantity = String(quantity);
    if (taxRateId !== undefined) set.taxRateBp = (await resolveTaxRateBp(tx, ctx, taxRateId)) ?? 0;
    const [row] = await tx.update(PL).set(set).where(and(eq(PL.tenantId, ctx.tenantId), eq(PL.id, lineId))).returning();
    await writeAudit(tx, ctx, { action: 'period_line.update', entityType: 'period_line', entityId: lineId, before, after: row });
    return toLine(row!);
  });
}

export async function deleteLine(db: Db, ctx: TenantContext, buildingId: string, id: string, lineId: string) {
  return db.transaction(async (tx) => {
    const period = await claimPeriod(tx, ctx, buildingId, id, ['open', 'generated']);
    if (period.status === 'generated') await resetDrafts(tx, ctx, id);
    const before = await tx.query.periodLines.findFirst({ where: and(eq(PL.tenantId, ctx.tenantId), eq(PL.periodId, id), eq(PL.id, lineId)) });
    if (!before) throw notFound('Period line');
    await tx.delete(PL).where(and(eq(PL.tenantId, ctx.tenantId), eq(PL.id, lineId)));
    await writeAudit(tx, ctx, { action: 'period_line.delete', entityType: 'period_line', entityId: lineId, before });
  });
}
