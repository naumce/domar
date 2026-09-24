import { type Db, schema } from '@domar/db';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { writeAudit } from '../audit.js';
import { logEmail } from '../email/log.js';
import type { Mailer } from '../email/mailer.js';
import { badRequest, notFound } from '../errors.js';
import { getContact } from '../resources/contacts/repo.js';
import type { TenantContext } from '../tenant-context.js';
import { generateInviteCode, hashCode } from './code.js';
import { deleteOwnerSessionsFor } from './session.js';

const PI = schema.portalInvites; const OCL = schema.ownerContactLinks;
const INVITE_DAYS = 14;
/** Wrong passwords a single code may collect before it is burned (plan addendum 3). */
const MAX_FAILED_ATTEMPTS = 5;

export interface PortalInviteRuntime {
  mailer: Mailer;
  log: { warn(obj: unknown, msg: string): void };
  /** Public origin of the web app; when the server knows it, the email carries the register link. */
  publicWebUrl?: string | undefined;
}

export type InviteRow = typeof PI.$inferSelect;

/**
 * Consumes a code. Claim-first: the same `UPDATE … RETURNING` both checks that the code is live and
 * marks it used, so two simultaneous registrations cannot both win it. `code_hash` is unique, so at
 * most one row can match. Nothing here knows a tenant yet — the tenant comes out of the claimed row.
 */
export async function claimInvite(tx: Db, code: string): Promise<InviteRow> {
  const [row] = await tx.update(PI)
    .set({ usedAt: new Date() })
    .where(and(eq(PI.codeHash, hashCode(code)), isNull(PI.usedAt), gt(PI.expiresAt, new Date())))
    .returning();
  if (!row) throw badRequest('invalid_code', 'The code is wrong, already used or expired');
  return row;
}

/**
 * Read-only peek at a live code, without consuming it. Registration runs this *before* it touches
 * the account, so a wrong code answers `400 invalid_code` whether or not the email is registered;
 * the claiming UPDATE in `claimInvite` remains the only atomic gate.
 */
export async function assertLiveInvite(db: Db, code: string): Promise<void> {
  const [row] = await db.select({ id: PI.id }).from(PI)
    .where(and(eq(PI.codeHash, hashCode(code)), isNull(PI.usedAt), gt(PI.expiresAt, new Date())))
    .limit(1);
  if (!row) throw badRequest('invalid_code', 'The code is wrong, already used or expired');
}

/**
 * Counts a wrong password offered against a live code and expires the code at the fifth. Registering
 * with a valid code answers `401` for a known email and `201` for an unknown one, which makes a code
 * a slow oracle over `owner_accounts` for its fourteen days; five tries is enough for an owner who
 * mistypes their own password and far too few to enumerate anything. Its own statement, outside the
 * failed request's transaction, so the count survives the 401.
 */
export async function countInviteFailure(db: Db, code: string): Promise<void> {
  const codeHash = hashCode(code);
  const [row] = await db.update(PI).set({ failedAttempts: sql`${PI.failedAttempts} + 1` })
    .where(eq(PI.codeHash, codeHash)).returning({ failedAttempts: PI.failedAttempts });
  if (row && row.failedAttempts >= MAX_FAILED_ATTEMPTS) {
    await db.update(PI).set({ expiresAt: new Date() }).where(eq(PI.codeHash, codeHash));
  }
}

/** `none` | `invited` | `linked` for one contact, plus the one date that matters for that state. */
export async function portalStatus(db: Db, ctx: TenantContext, contactId: string) {
  await getContact(db, ctx, contactId); // 404 across tenants
  const [link] = await db.select({ linkedAt: OCL.linkedAt }).from(OCL)
    .where(and(eq(OCL.tenantId, ctx.tenantId), eq(OCL.contactId, contactId)))
    .orderBy(desc(OCL.linkedAt)).limit(1);
  if (link) return { status: 'linked' as const, linkedAt: link.linkedAt };
  const [invite] = await db.select({ expiresAt: PI.expiresAt }).from(PI)
    .where(and(eq(PI.tenantId, ctx.tenantId), eq(PI.contactId, contactId), isNull(PI.usedAt), gt(PI.expiresAt, new Date())))
    .orderBy(desc(PI.expiresAt)).limit(1);
  if (invite) return { status: 'invited' as const, expiresAt: invite.expiresAt };
  return { status: 'none' as const };
}

/**
 * Issues a fresh code for a contact and revokes every earlier live one (spec §19.2). Revocation is
 * an expiry, not a `used_at`: `used_at` means "an owner turned this into a link", and `portal-status`
 * reads exactly those two columns.
 *
 * Two transactions, like the reminder send: the code is committed before the email is attempted, so
 * a dead SMTP server never invalidates a code the manager is already reading off the screen.
 */
export async function issuePortalInvite(db: Db, ctx: TenantContext, contactId: string, rt: PortalInviteRuntime) {
  const contact = await getContact(db, ctx, contactId); // 404 across tenants
  const code = generateInviteCode();
  const codeHash = hashCode(code);
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 24 * 3600 * 1000);

  const row = await db.transaction(async (tx) => {
    const revoked = await tx.update(PI).set({ expiresAt: new Date() })
      .where(and(eq(PI.tenantId, ctx.tenantId), eq(PI.contactId, contactId), isNull(PI.usedAt), gt(PI.expiresAt, new Date())))
      .returning({ id: PI.id });
    const [inserted] = await tx.insert(PI).values({ tenantId: ctx.tenantId, contactId, codeHash, expiresAt, createdBy: ctx.userId }).returning();
    // Neither the code nor its hash may reach the audit log: the log is readable by every owner user.
    await writeAudit(tx, ctx, {
      action: 'portal_invite.create', entityType: 'contact', entityId: contactId,
      after: { inviteId: inserted!.id, expiresAt: expiresAt.toISOString(), revokedCodes: revoked.length },
    });
    return inserted!;
  });

  const to = contact.email;
  if (!to || !rt.mailer.configured) return { code, expiresAt: row.expiresAt, emailed: false };

  const subject = 'Пристап до порталот за сопственици';
  const text = [
    `Почитувани ${contact.firstName} ${contact.lastName},`.trim(),
    '',
    'Вашиот управител ви овозможи пристап до порталот за сопственици.',
    `Код за пристап: ${code}`,
    `Кодот важи до ${row.expiresAt.toLocaleDateString('mk-MK')}.`,
    '',
    'Отворете ја страницата за регистрација, внесете го кодот, вашата е-пошта и лозинка по ваш избор.',
    ...(rt.publicWebUrl ? [`${rt.publicWebUrl}/portal/register`] : []),
  ].join('\n');
  const res = await rt.mailer.send({ to, subject, text });
  const ok = 'id' in res;
  if (!ok) rt.log.warn({ error: res.error, contactId }, 'portal invite email failed; the code is still valid');
  await db.transaction(async (tx) => {
    await logEmail(tx, ctx, { to, subject, template: 'portal_invite', refType: 'contact', refId: contactId, status: ok ? 'sent' : 'failed', error: ok ? null : res.error });
    await writeAudit(tx, ctx, { action: 'portal_invite.send', entityType: 'contact', entityId: contactId, after: { status: ok ? 'sent' : 'failed', to } });
  });
  return { code, expiresAt: row.expiresAt, emailed: ok };
}

/**
 * Undoes a claim: the manager read the code to the wrong person, or an owner typed a neighbour's
 * code. Deleting the link is the only recovery path — one contact is one owner login, so a reissued
 * code cannot be claimed while the wrong account still holds the link (spec §19.2). Ids only in the
 * audit row, like every other portal write. When the account keeps no link at all, its sessions go
 * too: nothing is left for them to read, and a dangling cookie would only 404 its way around.
 */
export async function deletePortalLink(db: Db, ctx: TenantContext, contactId: string): Promise<void> {
  await getContact(db, ctx, contactId); // 404 across tenants
  const ownerAccountId = await db.transaction(async (tx) => {
    const [deleted] = await tx.delete(OCL)
      .where(and(eq(OCL.tenantId, ctx.tenantId), eq(OCL.contactId, contactId)))
      .returning({ id: OCL.id, ownerAccountId: OCL.ownerAccountId });
    if (!deleted) throw notFound('Portal link');
    await writeAudit(tx, ctx, {
      action: 'portal_link.delete', entityType: 'contact', entityId: contactId,
      before: { linkId: deleted.id, ownerAccountId: deleted.ownerAccountId },
    });
    return deleted.ownerAccountId;
  });
  const [kept] = await db.select({ id: OCL.id }).from(OCL).where(eq(OCL.ownerAccountId, ownerAccountId)).limit(1);
  if (!kept) await deleteOwnerSessionsFor(db, ownerAccountId);
}
