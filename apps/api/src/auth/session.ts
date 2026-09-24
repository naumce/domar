import { createHash, randomBytes } from 'node:crypto';
import { type Db, schema } from '@domar/db';
import { and, eq, gt, ne } from 'drizzle-orm';

export const SESSION_COOKIE = 'domar_session';
const SESSION_DAYS = 14;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(db: Db, userId: string, meta: { userAgent?: string | undefined; ip?: string | undefined }): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000);
  await db.insert(schema.sessions).values({ tokenHash: hashToken(token), userId, expiresAt, userAgent: meta.userAgent ?? null, ip: meta.ip ?? null });
  return { token, expiresAt };
}

export async function resolveSession(db: Db, token: string) {
  const rows = await db
    .select({ user: schema.users, tenant: schema.tenants })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.users.tenantId))
    .where(and(eq(schema.sessions.tokenHash, hashToken(token)), gt(schema.sessions.expiresAt, new Date())))
    .limit(1);
  return rows[0] ?? null;
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, hashToken(token)));
}

/** Every session of a user: used when the user is deactivated or their password is reset by an owner. */
export async function deleteSessionsForUser(db: Db, userId: string): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
}

/** Every session of a user except the caller's own: used after a self-service password change. */
export async function deleteOtherSessionsForUser(db: Db, userId: string, keepToken: string): Promise<void> {
  await db.delete(schema.sessions).where(and(eq(schema.sessions.userId, userId), ne(schema.sessions.tokenHash, hashToken(keepToken))));
}
