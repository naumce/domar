import { type Db, schema } from '@domar/db';
import { and, asc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { writeAudit } from '../../audit.js';
import { badRequest, conflict, isUniqueViolation, notFound } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { getBuilding } from '../buildings/repo.js';
import { stripUndefined } from '../common.js';
import type { unitKindEnum } from '../common.js';
import type { BuildingServiceCreate, BuildingServicePatch } from './schema.js';

const BS = schema.buildingServices;
const S = schema.services;
type UnitKind = z.infer<typeof unitKindEnum>;

const selectShape = { bs: BS, service: S, rateBp: schema.taxRates.rateBp };
type Joined = { bs: typeof BS.$inferSelect; service: typeof S.$inferSelect; rateBp: number | null };

function toOut(r: Joined) {
  const service = { id: r.service.id, name: r.service.name, pricing: r.service.pricing, defaultPriceMinor: r.service.defaultPriceMinor, taxRateBp: r.rateBp ?? 0, appliesTo: r.service.appliesTo as UnitKind[], isActive: r.service.isActive };
  return { ...r.bs, effectivePriceMinor: r.bs.priceMinor ?? service.defaultPriceMinor, effectivePricing: r.bs.pricing ?? service.pricing, service };
}

function joinedQuery(db: Db) {
  return db.select(selectShape).from(BS).innerJoin(S, eq(S.id, BS.serviceId)).leftJoin(schema.taxRates, eq(schema.taxRates.id, S.taxRateId));
}

export async function listBuildingServices(db: Db, ctx: TenantContext, buildingId: string) {
  await getBuilding(db, ctx, buildingId);
  const rows = await joinedQuery(db).where(and(eq(BS.tenantId, ctx.tenantId), eq(BS.buildingId, buildingId))).orderBy(asc(S.name));
  return { rows: rows.map(toOut) };
}

export async function getBuildingService(db: Db, ctx: TenantContext, buildingId: string, id: string) {
  const rows = await joinedQuery(db).where(and(eq(BS.tenantId, ctx.tenantId), eq(BS.buildingId, buildingId), eq(BS.id, id))).limit(1);
  if (!rows[0]) throw notFound('Building service');
  return toOut(rows[0]);
}

async function assertRecurringService(db: Db, ctx: TenantContext, serviceId: string) {
  const s = await db.query.services.findFirst({ where: and(eq(S.tenantId, ctx.tenantId), eq(S.id, serviceId), eq(S.isActive, true), eq(S.recurring, true)), columns: { id: true } });
  if (!s) throw badRequest('invalid_reference', 'serviceId must be an active recurring service of this organization');
}

export async function attachService(db: Db, ctx: TenantContext, buildingId: string, input: BuildingServiceCreate) {
  return db.transaction(async (tx) => {
    await getBuilding(tx, ctx, buildingId);
    await assertRecurringService(tx, ctx, input.serviceId);
    const intervalMonths = input.frequency === 'monthly' ? 1 : input.intervalMonths;
    let row;
    try {
      [row] = await tx.insert(BS).values({ ...stripUndefined(input), serviceId: input.serviceId, startsPeriod: input.startsPeriod, frequency: input.frequency, intervalMonths, tenantId: ctx.tenantId, buildingId, priceMinor: input.priceMinor ?? null, pricing: input.pricing ?? null, endsPeriod: input.endsPeriod ?? null }).returning();
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('already_attached', 'This service is already attached to the building');
      throw e;
    }
    await writeAudit(tx, ctx, { action: 'building_service.attach', entityType: 'building_service', entityId: row!.id, after: row });
    return getBuildingService(tx, ctx, buildingId, row!.id);
  });
}

export async function updateBuildingService(db: Db, ctx: TenantContext, buildingId: string, id: string, patch: BuildingServicePatch) {
  return db.transaction(async (tx) => {
    const before = await getBuildingService(tx, ctx, buildingId, id);
    const frequency = patch.frequency ?? before.frequency;
    const intervalMonths = frequency === 'monthly' ? 1 : (patch.intervalMonths ?? before.intervalMonths);
    if (frequency === 'every_n_months' && intervalMonths < 2) throw badRequest('validation', 'intervalMonths must be ≥ 2 for every_n_months');
    const [row] = await tx.update(BS).set({ ...stripUndefined(patch), frequency, intervalMonths, updatedAt: new Date() }).where(and(eq(BS.tenantId, ctx.tenantId), eq(BS.id, id))).returning();
    await writeAudit(tx, ctx, { action: 'building_service.update', entityType: 'building_service', entityId: id, before, after: row });
    return getBuildingService(tx, ctx, buildingId, id);
  });
}

export async function detachService(db: Db, ctx: TenantContext, buildingId: string, id: string) {
  return db.transaction(async (tx) => {
    const before = await getBuildingService(tx, ctx, buildingId, id);
    await tx.delete(BS).where(and(eq(BS.tenantId, ctx.tenantId), eq(BS.id, id)));
    await writeAudit(tx, ctx, { action: 'building_service.detach', entityType: 'building_service', entityId: id, before });
  });
}
