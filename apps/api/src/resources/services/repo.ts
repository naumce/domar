import { type Db, schema } from '@domar/db';
import { and, asc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { writeAudit } from '../../audit.js';
import { badRequest, notFound } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { stripUndefined } from '../common.js';
import type { unitKindEnum } from '../common.js';
import type { ServiceCreate, ServicePatch } from './schema.js';

const S = schema.services;
type Row = typeof S.$inferSelect;
type UnitKind = z.infer<typeof unitKindEnum>;
type Out = Omit<Row, 'appliesTo'> & { appliesTo: UnitKind[]; taxRateBp: number };

function toOut(row: Row, rateBp: number | null): Out {
  return { ...row, appliesTo: row.appliesTo as UnitKind[], taxRateBp: rateBp ?? 0 };
}

/** Returns the tax rate's bp or throws invalid_reference; null taxRateId → null. */
export async function resolveTaxRateBp(db: Db, ctx: TenantContext, taxRateId: string | null | undefined): Promise<number | null> {
  if (!taxRateId) return null;
  const r = await db.query.taxRates.findFirst({ where: and(eq(schema.taxRates.tenantId, ctx.tenantId), eq(schema.taxRates.id, taxRateId), eq(schema.taxRates.isActive, true)), columns: { rateBp: true } });
  if (!r) throw badRequest('invalid_reference', 'taxRateId is not an active tax rate of this organization');
  return r.rateBp;
}

export async function listServices(db: Db, ctx: TenantContext, q: { includeInactive?: boolean | undefined; recurring?: boolean | undefined }) {
  const conds = [eq(S.tenantId, ctx.tenantId)];
  if (!q.includeInactive) conds.push(eq(S.isActive, true));
  if (q.recurring !== undefined) conds.push(eq(S.recurring, q.recurring));
  const rows = await db.select({ s: S, rateBp: schema.taxRates.rateBp }).from(S).leftJoin(schema.taxRates, eq(schema.taxRates.id, S.taxRateId)).where(and(...conds)).orderBy(asc(S.name));
  return { rows: rows.map((r) => toOut(r.s, r.rateBp)) };
}

export async function getService(db: Db, ctx: TenantContext, id: string): Promise<Out> {
  const rows = await db.select({ s: S, rateBp: schema.taxRates.rateBp }).from(S).leftJoin(schema.taxRates, eq(schema.taxRates.id, S.taxRateId)).where(and(eq(S.tenantId, ctx.tenantId), eq(S.id, id))).limit(1);
  const r = rows[0];
  if (!r) throw notFound('Service');
  return toOut(r.s, r.rateBp);
}

export async function createService(db: Db, ctx: TenantContext, input: ServiceCreate): Promise<Out> {
  return db.transaction(async (tx) => {
    const rateBp = await resolveTaxRateBp(tx, ctx, input.taxRateId);
    const [row] = await tx.insert(S).values({ ...stripUndefined(input), name: input.name, pricing: input.pricing, tenantId: ctx.tenantId, taxRateId: input.taxRateId ?? null }).returning();
    await writeAudit(tx, ctx, { action: 'service.create', entityType: 'service', entityId: row!.id, after: row });
    return toOut(row!, rateBp);
  });
}

export async function updateService(db: Db, ctx: TenantContext, id: string, patch: ServicePatch): Promise<Out> {
  return db.transaction(async (tx) => {
    const before = await getService(tx, ctx, id);
    if (patch.taxRateId !== undefined) await resolveTaxRateBp(tx, ctx, patch.taxRateId);
    const [row] = await tx.update(S).set({ ...stripUndefined(patch), updatedAt: new Date() }).where(and(eq(S.tenantId, ctx.tenantId), eq(S.id, id))).returning();
    await writeAudit(tx, ctx, { action: 'service.update', entityType: 'service', entityId: id, before, after: row });
    return getService(tx, ctx, id);
  });
}

export async function deactivateService(db: Db, ctx: TenantContext, id: string): Promise<void> {
  return db.transaction(async (tx) => {
    const before = await getService(tx, ctx, id);
    const [row] = await tx.update(S).set({ isActive: false, updatedAt: new Date() }).where(and(eq(S.tenantId, ctx.tenantId), eq(S.id, id))).returning();
    await writeAudit(tx, ctx, { action: 'service.deactivate', entityType: 'service', entityId: id, before, after: row });
  });
}
