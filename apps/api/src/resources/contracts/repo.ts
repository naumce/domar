import { type Db, schema } from '@domar/db';
import { and, asc, desc, eq } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { notFound } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { getBuilding } from '../buildings/repo.js';
import { stripUndefined } from '../common.js';
import { assertDocumentInTenant } from '../documents/repo.js';
import { assertSupplierInTenant } from '../suppliers/repo.js';
import type { ContractCreate, ContractPatch } from './schema.js';

const BC = schema.buildingContracts; const S = schema.suppliers; const D = schema.documents;

type Row = typeof BC.$inferSelect;
type Joined = { c: Row; supplierName: string | null; documentTitle: string | null; documentFileName: string | null };

const toOut = (r: Joined) => ({
  ...r.c,
  supplier: r.c.supplierId && r.supplierName !== null ? { id: r.c.supplierId, name: r.supplierName } : null,
  document: r.c.documentId && r.documentTitle !== null ? { id: r.c.documentId, title: r.documentTitle, fileName: r.documentFileName ?? '' } : null,
});

const selection = (db: Db) => db.select({
  c: BC, supplierName: S.name, documentTitle: D.title, documentFileName: D.fileName,
}).from(BC)
  .leftJoin(S, and(eq(S.id, BC.supplierId), eq(S.tenantId, BC.tenantId)))
  .leftJoin(D, and(eq(D.id, BC.documentId), eq(D.tenantId, BC.tenantId)));

export async function listContracts(db: Db, ctx: TenantContext, buildingId: string) {
  await getBuilding(db, ctx, buildingId); // 404 across tenants
  const rows = await selection(db)
    .where(and(eq(BC.tenantId, ctx.tenantId), eq(BC.buildingId, buildingId)))
    .orderBy(desc(BC.startsOn), asc(BC.title));
  return { rows: rows.map(toOut) };
}

export async function getContract(db: Db, ctx: TenantContext, buildingId: string, id: string) {
  const [row] = await selection(db).where(and(eq(BC.tenantId, ctx.tenantId), eq(BC.buildingId, buildingId), eq(BC.id, id))).limit(1);
  if (!row) throw notFound('Contract');
  return toOut(row);
}

export async function createContract(db: Db, ctx: TenantContext, buildingId: string, input: ContractCreate) {
  return db.transaction(async (tx) => {
    await getBuilding(tx, ctx, buildingId);
    await assertSupplierInTenant(tx, ctx, input.supplierId);
    await assertDocumentInTenant(tx, ctx, input.documentId);
    const [row] = await tx.insert(BC).values({
      ...stripUndefined(input), tenantId: ctx.tenantId, buildingId, kind: input.kind, title: input.title, startsOn: input.startsOn,
    }).returning();
    await writeAudit(tx, ctx, { action: 'contract.create', entityType: 'building_contract', entityId: row!.id, after: row });
    return getContract(tx, ctx, buildingId, row!.id);
  });
}

export async function updateContract(db: Db, ctx: TenantContext, buildingId: string, id: string, patch: ContractPatch) {
  return db.transaction(async (tx) => {
    const before = await tx.query.buildingContracts.findFirst({ where: and(eq(BC.tenantId, ctx.tenantId), eq(BC.buildingId, buildingId), eq(BC.id, id)) });
    if (!before) throw notFound('Contract');
    await assertSupplierInTenant(tx, ctx, patch.supplierId);
    await assertDocumentInTenant(tx, ctx, patch.documentId);
    const [row] = await tx.update(BC).set({ ...stripUndefined(patch), updatedAt: new Date() })
      .where(and(eq(BC.tenantId, ctx.tenantId), eq(BC.id, id))).returning();
    await writeAudit(tx, ctx, { action: 'contract.update', entityType: 'building_contract', entityId: id, before, after: row });
    return getContract(tx, ctx, buildingId, id);
  });
}

export async function deleteContract(db: Db, ctx: TenantContext, buildingId: string, id: string) {
  return db.transaction(async (tx) => {
    const before = await tx.query.buildingContracts.findFirst({ where: and(eq(BC.tenantId, ctx.tenantId), eq(BC.buildingId, buildingId), eq(BC.id, id)) });
    if (!before) throw notFound('Contract');
    await tx.delete(BC).where(and(eq(BC.tenantId, ctx.tenantId), eq(BC.id, id)));
    await writeAudit(tx, ctx, { action: 'contract.delete', entityType: 'building_contract', entityId: id, before });
  });
}
