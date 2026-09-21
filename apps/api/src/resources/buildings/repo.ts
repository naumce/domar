import { type Db, schema } from '@domar/db';
import { and, asc, eq, sql } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { badRequest, notFound } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { stripUndefined } from '../common.js';
import type { BuildingCreate, BuildingPatch } from './schema.js';

const B = schema.buildings;

async function assertContactInTenant(db: Db, ctx: TenantContext, contactId: string | null | undefined) {
  if (!contactId) return;
  const c = await db.query.contacts.findFirst({ where: and(eq(schema.contacts.tenantId, ctx.tenantId), eq(schema.contacts.id, contactId)), columns: { id: true } });
  if (!c) throw badRequest('invalid_reference', 'representativeContactId does not belong to this organization');
}

export async function listBuildings(db: Db, ctx: TenantContext) {
  const rows = await db
    .select({ building: B, unitCount: sql<number>`(select count(*) from ${schema.units} u where u.building_id = ${B.id})`.mapWith(Number) })
    .from(B).where(eq(B.tenantId, ctx.tenantId)).orderBy(asc(B.name));
  return { rows: rows.map((r) => ({ ...r.building, unitCount: r.unitCount })) };
}

export async function getBuilding(db: Db, ctx: TenantContext, id: string) {
  const row = await db.query.buildings.findFirst({ where: and(eq(B.tenantId, ctx.tenantId), eq(B.id, id)) });
  if (!row) throw notFound('Building');
  return row;
}

export async function createBuilding(db: Db, ctx: TenantContext, input: BuildingCreate) {
  return db.transaction(async (tx) => {
    await assertContactInTenant(tx, ctx, input.representativeContactId);
    const tenant = await tx.query.tenants.findFirst({ where: eq(schema.tenants.id, ctx.tenantId), columns: { countryCode: true } });
    const [row] = await tx.insert(B).values({
      ...stripUndefined(input),
      tenantId: ctx.tenantId,
      name: input.name,
      countryCode: input.countryCode ?? tenant!.countryCode,
    }).returning();
    await writeAudit(tx, ctx, { action: 'building.create', entityType: 'building', entityId: row!.id, after: row });
    return row!;
  });
}

export async function updateBuilding(db: Db, ctx: TenantContext, id: string, patch: BuildingPatch) {
  return db.transaction(async (tx) => {
    const before = await getBuilding(tx, ctx, id);
    await assertContactInTenant(tx, ctx, patch.representativeContactId);
    const [row] = await tx.update(B).set({ ...stripUndefined(patch), updatedAt: new Date() }).where(and(eq(B.tenantId, ctx.tenantId), eq(B.id, id))).returning();
    await writeAudit(tx, ctx, { action: 'building.update', entityType: 'building', entityId: id, before, after: row });
    return row!;
  });
}

export async function deleteBuilding(db: Db, ctx: TenantContext, id: string) {
  return db.transaction(async (tx) => {
    const before = await getBuilding(tx, ctx, id);
    await tx.delete(B).where(and(eq(B.tenantId, ctx.tenantId), eq(B.id, id)));
    await writeAudit(tx, ctx, { action: 'building.delete', entityType: 'building', entityId: id, before });
  });
}
