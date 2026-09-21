import { type Db, schema } from '@domar/db';
import { and, eq, ne } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { badRequest, notFound } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { stripUndefined } from '../common.js';
import type { TaxRateCreate, TaxRatePatch } from './schema.js';

const T = schema.taxRates;

export async function listTaxRates(db: Db, ctx: TenantContext, includeInactive = false) {
  return db.query.taxRates.findMany({
    where: includeInactive ? eq(T.tenantId, ctx.tenantId) : and(eq(T.tenantId, ctx.tenantId), eq(T.isActive, true)),
    orderBy: (t, { asc }) => [asc(t.rateBp)],
  });
}

export async function getTaxRate(db: Db, ctx: TenantContext, id: string) {
  const row = await db.query.taxRates.findFirst({ where: and(eq(T.tenantId, ctx.tenantId), eq(T.id, id)) });
  if (!row) throw notFound('Tax rate');
  return row;
}

export async function createTaxRate(db: Db, ctx: TenantContext, input: TaxRateCreate) {
  return db.transaction(async (tx) => {
    if (input.isDefault) await tx.update(T).set({ isDefault: false }).where(eq(T.tenantId, ctx.tenantId));
    const [row] = await tx.insert(T).values({ tenantId: ctx.tenantId, name: input.name, rateBp: input.rateBp, isDefault: input.isDefault ?? false }).returning();
    await writeAudit(tx, ctx, { action: 'tax_rate.create', entityType: 'tax_rate', entityId: row!.id, after: row });
    return row!;
  });
}

export async function updateTaxRate(db: Db, ctx: TenantContext, id: string, patch: TaxRatePatch) {
  return db.transaction(async (tx) => {
    const before = await getTaxRate(tx, ctx, id);
    if (patch.isDefault === true && before.isActive === false) throw badRequest('inactive_default', 'An inactive tax rate cannot be the default');
    if (patch.isDefault) await tx.update(T).set({ isDefault: false }).where(and(eq(T.tenantId, ctx.tenantId), ne(T.id, id)));
    const [row] = await tx.update(T).set({ ...stripUndefined(patch), updatedAt: new Date() }).where(and(eq(T.tenantId, ctx.tenantId), eq(T.id, id))).returning();
    await writeAudit(tx, ctx, { action: 'tax_rate.update', entityType: 'tax_rate', entityId: id, before, after: row });
    return row!;
  });
}

export async function deactivateTaxRate(db: Db, ctx: TenantContext, id: string) {
  return db.transaction(async (tx) => {
    const before = await getTaxRate(tx, ctx, id);
    const [row] = await tx.update(T).set({ isActive: false, isDefault: false, updatedAt: new Date() }).where(and(eq(T.tenantId, ctx.tenantId), eq(T.id, id))).returning();
    await writeAudit(tx, ctx, { action: 'tax_rate.deactivate', entityType: 'tax_rate', entityId: id, before, after: row });
  });
}
