import { type Db, schema } from '@domar/db';
import { and, asc, eq } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { generateTemporaryPassword, hashPassword, verifyPassword } from '../../auth/password.js';
import { deleteOtherSessionsForUser, deleteSessionsForUser } from '../../auth/session.js';
import { AppError, conflict, isUniqueViolation, notFound } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { stripUndefined } from '../common.js';
import type { UserCreate, UserPatch } from './schema.js';

const U = schema.users;
type Row = typeof U.$inferSelect;
export type PublicUser = { id: string; email: string; firstName: string; lastName: string; role: Row['role']; isActive: boolean };

/** A password hash must never reach a response or the audit log. */
function publicUser(row: Row): PublicUser {
  return { id: row.id, email: row.email, firstName: row.firstName, lastName: row.lastName, role: row.role, isActive: row.isActive };
}

export async function listUsers(db: Db, ctx: TenantContext) {
  // Only the six public columns: a password hash should not even be read into memory.
  const rows = await db.select({ id: U.id, email: U.email, firstName: U.firstName, lastName: U.lastName, role: U.role, isActive: U.isActive })
    .from(U).where(eq(U.tenantId, ctx.tenantId)).orderBy(asc(U.lastName), asc(U.firstName));
  return { rows };
}

async function getUser(db: Db, ctx: TenantContext, id: string): Promise<Row> {
  const row = await db.query.users.findFirst({ where: and(eq(U.tenantId, ctx.tenantId), eq(U.id, id)) });
  if (!row) throw notFound('User');
  return row;
}

/**
 * The ids of the tenant's active owners, with those rows locked for the rest of the transaction.
 * Locking is what makes the last-owner rule safe: two owners demoting each other at the same time
 * would otherwise both read "one other owner is left" and both commit. The second transaction
 * blocks here and, once the first commits, re-evaluates the filter against the new row, so it sees
 * the demoted owner disappear. Ordered by id so concurrent calls take the locks in the same order.
 */
async function lockActiveOwners(tx: Db, ctx: TenantContext): Promise<string[]> {
  const rows = await tx.select({ id: U.id }).from(U)
    .where(and(eq(U.tenantId, ctx.tenantId), eq(U.role, 'owner'), eq(U.isActive, true)))
    .orderBy(asc(U.id))
    .for('update');
  return rows.map((r) => r.id);
}

export async function createUser(db: Db, ctx: TenantContext, input: UserCreate) {
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const email = input.email.toLowerCase();
  return db.transaction(async (tx) => {
    let row: Row | undefined;
    try {
      [row] = await tx.insert(U).values({
        tenantId: ctx.tenantId, email, passwordHash, firstName: input.firstName, lastName: input.lastName, role: input.role,
      }).returning();
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('email_taken', 'A user with that email already exists in this organization');
      throw err;
    }
    if (!row) throw new AppError(500, 'internal', 'user insert failed');
    await writeAudit(tx, ctx, { action: 'user.create', entityType: 'user', entityId: row.id, after: publicUser(row) });
    return { user: publicUser(row), temporaryPassword };
  });
}

export async function updateUser(db: Db, ctx: TenantContext, id: string, patch: UserPatch) {
  const mayLoseAnOwner = (patch.role !== undefined && patch.role !== 'owner') || patch.isActive === false;
  return db.transaction(async (tx) => {
    const activeOwnerIds = mayLoseAnOwner ? await lockActiveOwners(tx, ctx) : [];
    const before = await getUser(tx, ctx, id);
    const losesTheLastOwner = mayLoseAnOwner && before.role === 'owner' && before.isActive;
    if (losesTheLastOwner && activeOwnerIds.every((ownerId) => ownerId === id)) {
      throw conflict('last_owner', 'The last active owner cannot be demoted or deactivated');
    }
    const [row] = await tx.update(U).set({ ...stripUndefined(patch), updatedAt: new Date() })
      .where(and(eq(U.tenantId, ctx.tenantId), eq(U.id, id))).returning();
    if (!row) throw notFound('User');
    if (patch.isActive === false) await deleteSessionsForUser(tx, id);
    await writeAudit(tx, ctx, { action: 'user.update', entityType: 'user', entityId: id, before: publicUser(before), after: publicUser(row) });
    return publicUser(row);
  });
}

export async function resetUserPassword(db: Db, ctx: TenantContext, id: string) {
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  return db.transaction(async (tx) => {
    const before = await getUser(tx, ctx, id);
    const [row] = await tx.update(U).set({ passwordHash, updatedAt: new Date() })
      .where(and(eq(U.tenantId, ctx.tenantId), eq(U.id, id))).returning();
    if (!row) throw notFound('User');
    await deleteSessionsForUser(tx, id);
    await writeAudit(tx, ctx, { action: 'user.reset_password', entityType: 'user', entityId: id, after: { email: before.email } });
    return { user: publicUser(row), temporaryPassword };
  });
}

/** Self-service. `keepToken` is the caller's session token: every other session of theirs is dropped. */
export async function changeOwnPassword(db: Db, ctx: TenantContext, currentPassword: string, newPassword: string, keepToken: string): Promise<void> {
  const userId = ctx.userId!; // behind requireAuth: a session always carries a user
  const user = await getUser(db, ctx, userId);
  if (!(await verifyPassword(currentPassword, user.passwordHash))) throw new AppError(401, 'invalid_credentials', 'The current password is wrong');
  const passwordHash = await hashPassword(newPassword);
  await db.transaction(async (tx) => {
    await tx.update(U).set({ passwordHash, updatedAt: new Date() }).where(and(eq(U.tenantId, ctx.tenantId), eq(U.id, userId)));
    await deleteOtherSessionsForUser(tx, userId, keepToken);
    await writeAudit(tx, ctx, { action: 'user.change_password', entityType: 'user', entityId: userId });
  });
}
