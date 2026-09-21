import { type Db, schema } from '@domar/db';
import { and, asc, eq } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { badRequest, conflict, notFound } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { getBuilding } from '../buildings/repo.js';
import { stripUndefined } from '../common.js';
import type { UnitCreate, UnitPatch } from './schema.js';

const U = schema.units;
type Row = typeof U.$inferSelect;
type Owner = { id: string; firstName: string; lastName: string } | null;

/** Postgres unique_violation (23505) as raised by the `postgres` driver. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === '23505';
}

function toOut(row: Row, owner: Owner) {
  return { ...row, areaM2: row.areaM2 === null ? null : Number(row.areaM2), ownershipShare: row.ownershipShare === null ? null : Number(row.ownershipShare), owner };
}

function toRow(input: UnitPatch) {
  const { areaM2, ownershipShare, ...rest } = input;
  return {
    ...rest,
    ...(areaM2 !== undefined ? { areaM2: areaM2 === null ? null : areaM2.toString() } : {}),
    ...(ownershipShare !== undefined ? { ownershipShare: ownershipShare === null ? null : ownershipShare.toString() } : {}),
  };
}

async function validateRefs(db: Db, ctx: TenantContext, buildingId: string, input: UnitPatch, selfId?: string) {
  if (input.ownerContactId) {
    const c = await db.query.contacts.findFirst({ where: and(eq(schema.contacts.tenantId, ctx.tenantId), eq(schema.contacts.id, input.ownerContactId)), columns: { id: true } });
    if (!c) throw badRequest('invalid_reference', 'ownerContactId does not belong to this organization');
  }
  if (input.attachedToUnitId) {
    if (input.attachedToUnitId === selfId) throw badRequest('invalid_attachment', 'a unit cannot be attached to itself');
    const target = await db.query.units.findFirst({ where: and(eq(U.tenantId, ctx.tenantId), eq(U.buildingId, buildingId), eq(U.id, input.attachedToUnitId)) });
    if (!target || !['apartment', 'commercial'].includes(target.kind)) throw badRequest('invalid_attachment', 'attachedToUnitId must be an apartment or commercial unit in the same building');
  }
}

async function ownerOf(db: Db, ownerContactId: string | null): Promise<Owner> {
  if (!ownerContactId) return null;
  const c = await db.query.contacts.findFirst({ where: eq(schema.contacts.id, ownerContactId), columns: { id: true, firstName: true, lastName: true } });
  return c ?? null;
}

export async function listUnits(db: Db, ctx: TenantContext, buildingId: string) {
  await getBuilding(db, ctx, buildingId);
  const rows = await db
    .select({ unit: U, owner: { id: schema.contacts.id, firstName: schema.contacts.firstName, lastName: schema.contacts.lastName } })
    .from(U).leftJoin(schema.contacts, eq(schema.contacts.id, U.ownerContactId))
    .where(and(eq(U.tenantId, ctx.tenantId), eq(U.buildingId, buildingId))).orderBy(asc(U.floor), asc(U.label));
  return { rows: rows.map((r) => toOut(r.unit, r.owner?.id ? r.owner : null)) };
}

export async function getUnit(db: Db, ctx: TenantContext, buildingId: string, id: string) {
  const row = await db.query.units.findFirst({ where: and(eq(U.tenantId, ctx.tenantId), eq(U.buildingId, buildingId), eq(U.id, id)) });
  if (!row) throw notFound('Unit');
  return row;
}

export async function createUnit(db: Db, ctx: TenantContext, buildingId: string, input: UnitCreate) {
  return db.transaction(async (tx) => {
    await getBuilding(tx, ctx, buildingId);
    await validateRefs(tx, ctx, buildingId, input);
    const dup = await tx.query.units.findFirst({ where: and(eq(U.buildingId, buildingId), eq(U.label, input.label)), columns: { id: true } });
    if (dup) throw conflict('label_taken', `Unit ${input.label} already exists in this building`);
    let row: Row | undefined;
    try {
      [row] = await tx.insert(U).values({ ...stripUndefined(toRow(input)), tenantId: ctx.tenantId, buildingId, label: input.label, kind: input.kind }).returning();
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('label_taken', `Unit ${input.label} already exists in this building`);
      throw err;
    }
    await writeAudit(tx, ctx, { action: 'unit.create', entityType: 'unit', entityId: row!.id, after: row });
    return toOut(row!, await ownerOf(tx, row!.ownerContactId));
  });
}

export async function updateUnit(db: Db, ctx: TenantContext, buildingId: string, id: string, patch: UnitPatch) {
  return db.transaction(async (tx) => {
    const before = await getUnit(tx, ctx, buildingId, id);
    await validateRefs(tx, ctx, buildingId, patch, id);
    if (patch.label && patch.label !== before.label) {
      const dup = await tx.query.units.findFirst({ where: and(eq(U.buildingId, buildingId), eq(U.label, patch.label)), columns: { id: true } });
      if (dup) throw conflict('label_taken', `Unit ${patch.label} already exists in this building`);
    }
    let row: Row | undefined;
    try {
      [row] = await tx.update(U).set({ ...stripUndefined(toRow(patch)), updatedAt: new Date() }).where(and(eq(U.tenantId, ctx.tenantId), eq(U.id, id))).returning();
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('label_taken', `Unit ${patch.label} already exists in this building`);
      throw err;
    }
    await writeAudit(tx, ctx, { action: 'unit.update', entityType: 'unit', entityId: id, before, after: row });
    return toOut(row!, await ownerOf(tx, row!.ownerContactId));
  });
}

export async function deleteUnit(db: Db, ctx: TenantContext, buildingId: string, id: string) {
  return db.transaction(async (tx) => {
    const before = await getUnit(tx, ctx, buildingId, id);
    await tx.delete(U).where(and(eq(U.tenantId, ctx.tenantId), eq(U.id, id)));
    await writeAudit(tx, ctx, { action: 'unit.delete', entityType: 'unit', entityId: id, before });
  });
}
