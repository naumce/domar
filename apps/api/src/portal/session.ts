import { createHash, randomBytes } from 'node:crypto';
import { type Db, schema } from '@domar/db';
import { and, eq, gt, ne } from 'drizzle-orm';
import type { PortalLink } from './context.js';

export const OWNER_SESSION_COOKIE = 'domar_owner';
/** 30 days, not the staff 14: an owner signs in a few times a year, a bookkeeper every morning. */
const OWNER_SESSION_DAYS = 30;

const OS = schema.ownerSessions; const OA = schema.ownerAccounts; const OCL = schema.ownerContactLinks;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createOwnerSession(db: Db, ownerAccountId: string, meta: { userAgent?: string | undefined; ip?: string | undefined }): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + OWNER_SESSION_DAYS * 24 * 3600 * 1000);
  await db.insert(OS).values({ tokenHash: hashToken(token), ownerAccountId, expiresAt, userAgent: meta.userAgent ?? null, ip: meta.ip ?? null });
  return { token, expiresAt };
}

export async function resolveOwnerSession(db: Db, token: string) {
  const rows = await db.select({ account: OA }).from(OS)
    .innerJoin(OA, eq(OA.id, OS.ownerAccountId))
    .where(and(eq(OS.tokenHash, hashToken(token)), gt(OS.expiresAt, new Date())))
    .limit(1);
  return rows[0] ?? null;
}

export async function deleteOwnerSession(db: Db, token: string): Promise<void> {
  await db.delete(OS).where(eq(OS.tokenHash, hashToken(token)));
}

/** Every session of an owner except the caller's own: used after a self-service password change. */
export async function deleteOtherOwnerSessions(db: Db, ownerAccountId: string, keepToken: string): Promise<void> {
  await db.delete(OS).where(and(eq(OS.ownerAccountId, ownerAccountId), ne(OS.tokenHash, hashToken(keepToken))));
}

/** The account's links, sorted so `/me` and the web store agree on which one comes first. */
export async function listLinks(db: Db, ownerAccountId: string): Promise<PortalLink[]> {
  const rows = await db.select({ tenantId: OCL.tenantId, contactId: OCL.contactId }).from(OCL)
    .where(eq(OCL.ownerAccountId, ownerAccountId))
    .orderBy(OCL.linkedAt, OCL.contactId);
  return rows;
}
