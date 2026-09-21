import { type Db, schema } from '@domar/db';
import { and, asc, count, eq, ilike, or } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { notFound } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { stripUndefined } from '../common.js';
import type { ContactCreate, ContactPatch } from './schema.js';

const C = schema.contacts;

export async function listContacts(db: Db, ctx: TenantContext, q: { search?: string | undefined; page: number; pageSize: number }) {
  const term = q.search?.replace(/[\\%_]/g, (m) => '\\' + m);
  const where = term
    ? and(eq(C.tenantId, ctx.tenantId), or(ilike(C.firstName, `%${term}%`), ilike(C.lastName, `%${term}%`), ilike(C.email, `%${term}%`)))
    : eq(C.tenantId, ctx.tenantId);
  const [rows, totalRows] = await Promise.all([
    db.select().from(C).where(where).orderBy(asc(C.lastName), asc(C.firstName)).limit(q.pageSize).offset((q.page - 1) * q.pageSize),
    db.select({ total: count() }).from(C).where(where),
  ]);
  const total = Number(totalRows[0]?.total ?? 0);
  return { rows, total };
}

export async function getContact(db: Db, ctx: TenantContext, id: string) {
  const row = await db.query.contacts.findFirst({ where: and(eq(C.tenantId, ctx.tenantId), eq(C.id, id)) });
  if (!row) throw notFound('Contact');
  return row;
}

export async function createContact(db: Db, ctx: TenantContext, input: ContactCreate) {
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(C).values({ ...stripUndefined(input), tenantId: ctx.tenantId, kind: input.kind, firstName: input.firstName, lastName: input.lastName }).returning();
    await writeAudit(tx, ctx, { action: 'contact.create', entityType: 'contact', entityId: row!.id, after: row });
    return row!;
  });
}

export async function updateContact(db: Db, ctx: TenantContext, id: string, patch: ContactPatch) {
  return db.transaction(async (tx) => {
    const before = await getContact(tx, ctx, id);
    const [row] = await tx.update(C).set({ ...stripUndefined(patch), updatedAt: new Date() }).where(and(eq(C.tenantId, ctx.tenantId), eq(C.id, id))).returning();
    await writeAudit(tx, ctx, { action: 'contact.update', entityType: 'contact', entityId: id, before, after: row });
    return row!;
  });
}

export async function deleteContact(db: Db, ctx: TenantContext, id: string) {
  return db.transaction(async (tx) => {
    const before = await getContact(tx, ctx, id);
    await tx.delete(C).where(and(eq(C.tenantId, ctx.tenantId), eq(C.id, id)));
    await writeAudit(tx, ctx, { action: 'contact.delete', entityType: 'contact', entityId: id, before });
  });
}
