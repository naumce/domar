import { type Db, schema } from '@domar/db';
import { and, asc, eq } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { badRequest, conflict, notFound } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { stripUndefined } from '../common.js';
import type { SupplierCreate, SupplierPatch } from './schema.js';

const S = schema.suppliers; const BC = schema.buildingContracts; const E = schema.expenses;

export async function assertSupplierInTenant(db: Db, ctx: TenantContext, id: string | null | undefined): Promise<void> {
  if (!id) return;
  const [row] = await db.select({ id: S.id }).from(S).where(and(eq(S.tenantId, ctx.tenantId), eq(S.id, id))).limit(1);
  if (!row) throw badRequest('invalid_reference', 'supplierId does not belong to this organization');
}

export async function getSupplier(db: Db, ctx: TenantContext, id: string) {
  const row = await db.query.suppliers.findFirst({ where: and(eq(S.tenantId, ctx.tenantId), eq(S.id, id)) });
  if (!row) throw notFound('Supplier');
  return row;
}

export async function listSuppliers(db: Db, ctx: TenantContext, includeInactive: boolean) {
  const rows = await db.select().from(S)
    .where(and(eq(S.tenantId, ctx.tenantId), ...(includeInactive ? [] : [eq(S.isActive, true)])))
    .orderBy(asc(S.name));
  return { rows };
}

export async function createSupplier(db: Db, ctx: TenantContext, input: SupplierCreate) {
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(S).values({ ...stripUndefined(input), tenantId: ctx.tenantId, name: input.name }).returning();
    await writeAudit(tx, ctx, { action: 'supplier.create', entityType: 'supplier', entityId: row!.id, after: row });
    return row!;
  });
}

export async function updateSupplier(db: Db, ctx: TenantContext, id: string, patch: SupplierPatch) {
  return db.transaction(async (tx) => {
    const before = await getSupplier(tx, ctx, id);
    const [row] = await tx.update(S).set({ ...stripUndefined(patch), updatedAt: new Date() })
      .where(and(eq(S.tenantId, ctx.tenantId), eq(S.id, id))).returning();
    await writeAudit(tx, ctx, { action: 'supplier.update', entityType: 'supplier', entityId: id, before, after: row });
    return row!;
  });
}

/** Like a contact with financial history: a referenced supplier is deactivated, never deleted. */
export async function deleteSupplier(db: Db, ctx: TenantContext, id: string) {
  const before = await getSupplier(db, ctx, id);
  const [contract] = await db.select({ id: BC.id }).from(BC).where(and(eq(BC.tenantId, ctx.tenantId), eq(BC.supplierId, id))).limit(1);
  const [expense] = await db.select({ id: E.id }).from(E).where(and(eq(E.tenantId, ctx.tenantId), eq(E.supplierId, id))).limit(1);
  if (contract || expense) throw conflict('supplier_referenced', 'This supplier is used by a contract or an expense; deactivate it instead');
  await db.transaction(async (tx) => {
    await tx.delete(S).where(and(eq(S.tenantId, ctx.tenantId), eq(S.id, id)));
    await writeAudit(tx, ctx, { action: 'supplier.delete', entityType: 'supplier', entityId: id, before });
  });
}
