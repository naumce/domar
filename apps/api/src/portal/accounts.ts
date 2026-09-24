import { type Db, schema } from '@domar/db';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { writeAudit } from '../audit.js';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../auth/password.js';
import { AppError, conflict, isUniqueViolation } from '../errors.js';
import { recordLegalEventOnce } from '../legal-events.js';
import type { TenantContext } from '../tenant-context.js';
import type { PortalContext } from './context.js';
import { assertLiveInvite, claimInvite, countInviteFailure } from './invites.js';
import { deleteOtherOwnerSessions, listLinks } from './session.js';

const OA = schema.ownerAccounts; const OCL = schema.ownerContactLinks; const C = schema.contacts;
const T = schema.tenants; const B = schema.buildings; const U = schema.units;

type Account = typeof OA.$inferSelect;
export type PublicAccount = { id: string; email: string };
const publicAccount = (row: Account): PublicAccount => ({ id: row.id, email: row.email });

const invalid = () => new AppError(401, 'invalid_credentials', 'Invalid email or password');

/**
 * The read-only tenant context a portal request may act under: no user, so `audit_logs.user_id`
 * stays null, and the role is the least privileged one the enum has. Built here and in `repo.ts`
 * only (spec §19.6).
 */
export function portalTenantContext(tenantId: string): TenantContext {
  return { tenantId, userId: null, role: 'readonly' };
}

/**
 * Inserts the link and its audit row. `409 already_linked` when this account already holds the
 * contact, `409 contact_already_linked` when a different account does: one contact is one owner
 * login in this phase, and the manager reissues the code if the wrong person claimed it.
 */
async function linkContact(tx: Db, ownerAccountId: string, tenantId: string, contactId: string) {
  const [taken] = await tx.select({ ownerAccountId: OCL.ownerAccountId }).from(OCL)
    .where(and(eq(OCL.tenantId, tenantId), eq(OCL.contactId, contactId))).limit(1);
  if (taken && taken.ownerAccountId !== ownerAccountId) {
    throw conflict('contact_already_linked', 'This property is already linked to another portal account');
  }
  let row;
  try {
    [row] = await tx.insert(OCL).values({ ownerAccountId, tenantId, contactId }).returning();
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('already_linked', 'This property is already linked to your account');
    throw err;
  }
  await writeAudit(tx, portalTenantContext(tenantId), {
    action: 'portal_link.create', entityType: 'contact', entityId: contactId,
    after: { ownerAccountId, linkId: row!.id },
  });
  // Art. 45(4): from the first linked owner on, the building's fund statement is available online.
  // `selectDistinct` because an owner may hold several units in the same building.
  const owned = await tx.selectDistinct({ buildingId: U.buildingId }).from(U)
    .where(and(eq(U.tenantId, tenantId), eq(U.ownerContactId, contactId)));
  for (const b of owned) {
    await recordLegalEventOnce(tx, portalTenantContext(tenantId), {
      buildingId: b.buildingId, kind: 'fund_statement_available', refType: 'contact', refId: contactId,
      evidence: { contactId, ownerAccountId },
    });
  }
  return row!;
}

/**
 * Register with a code. The code is checked first, read-only: a wrong code answers `400
 * invalid_code` for every email, so registration cannot be used as an oracle for which addresses
 * already have an account. Only then does the email matter — an address that already has an account
 * must prove it with that account's password (spec §19.3), and that check too runs *before* the
 * transaction, so a wrong password never consumes the code. The claiming UPDATE inside the
 * transaction stays the atomic gate: the read-only peek is a courtesy, never the guarantee. Failures
 * are counted per code and the fifth one expires it, so the residual oracle cannot be worked.
 */
export async function registerPortalAccount(db: Db, input: { code: string; email: string; password: string }) {
  await assertLiveInvite(db, input.code); // 400 invalid_code, before the account is even looked up
  const email = input.email.toLowerCase();
  const existing = (await db.query.ownerAccounts.findFirst({ where: eq(OA.email, email) })) ?? null;
  const ok = await verifyPassword(input.password, existing?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (existing && (!ok || !existing.isActive)) {
    // The 401-vs-201 split still tells a code holder whether an address is registered; the counter
    // caps that probing at five tries per code (design addendum 3).
    await countInviteFailure(db, input.code);
    throw invalid();
  }
  const passwordHash = existing ? existing.passwordHash : await hashPassword(input.password);

  return db.transaction(async (tx) => {
    const invite = await claimInvite(tx, input.code); // 400 invalid_code, claim-first
    let account = existing;
    if (!account) {
      try {
        const [inserted] = await tx.insert(OA).values({ email, passwordHash }).returning();
        account = inserted ?? null;
      } catch (err) {
        // A concurrent registration with the same email won the race; that caller's password is the
        // account's password, so this one must sign in instead of guessing it.
        if (isUniqueViolation(err)) throw conflict('email_taken', 'An account with that email already exists; sign in and add the code there');
        throw err;
      }
    }
    await linkContact(tx, account!.id, invite.tenantId, invite.contactId);
    return account!;
  });
}

export async function loginPortalAccount(db: Db, input: { email: string; password: string }): Promise<Account> {
  const account = (await db.query.ownerAccounts.findFirst({ where: eq(OA.email, input.email.toLowerCase()) })) ?? null;
  const ok = await verifyPassword(input.password, account?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!account || !ok || !account.isActive) throw invalid();
  return account;
}

/** Adds one more contact to a signed-in account. Returns the `/me` shape of the new link. */
export async function linkAnotherContact(db: Db, portal: PortalContext, code: string) {
  const contactId = await db.transaction(async (tx) => {
    const invite = await claimInvite(tx, code);
    await linkContact(tx, portal.ownerAccountId, invite.tenantId, invite.contactId);
    return invite.contactId;
  });
  const links = await describeLinks(db, await listLinks(db, portal.ownerAccountId));
  const created = links.find((l) => l.contactId === contactId);
  if (!created) throw new AppError(500, 'internal', 'the link was written but could not be read back');
  return created;
}

export async function changePortalPassword(db: Db, portal: PortalContext, currentPassword: string, newPassword: string, keepToken: string): Promise<void> {
  const account = await db.query.ownerAccounts.findFirst({ where: eq(OA.id, portal.ownerAccountId) });
  if (!account || !(await verifyPassword(currentPassword, account.passwordHash))) throw new AppError(401, 'invalid_credentials', 'The current password is wrong');
  const passwordHash = await hashPassword(newPassword);
  await db.transaction(async (tx) => {
    await tx.update(OA).set({ passwordHash, updatedAt: new Date() }).where(eq(OA.id, portal.ownerAccountId));
    await deleteOtherOwnerSessions(tx, portal.ownerAccountId, keepToken);
  });
}

export interface PortalLinkOut {
  tenantId: string;
  tenantName: string;
  contactId: string;
  contactName: string;
  buildings: { id: string; name: string }[];
}

/**
 * Decorates raw links with the names the portal shows. Every query is filtered by the link's own
 * tenant id *and* its contact id: nothing here can reach a row the owner is not linked to.
 */
export async function describeLinks(db: Db, links: { tenantId: string; contactId: string }[]): Promise<PortalLinkOut[]> {
  if (links.length === 0) return [];
  const tenantIds = [...new Set(links.map((l) => l.tenantId))];
  const contactIds = links.map((l) => l.contactId);
  const [tenants, contacts, buildings] = await Promise.all([
    db.select({ id: T.id, name: T.name }).from(T).where(inArray(T.id, tenantIds)),
    db.select({ id: C.id, tenantId: C.tenantId, firstName: C.firstName, lastName: C.lastName }).from(C)
      .where(and(inArray(C.tenantId, tenantIds), inArray(C.id, contactIds))),
    db.selectDistinct({ id: B.id, name: B.name, tenantId: B.tenantId, contactId: U.ownerContactId }).from(U)
      .innerJoin(B, and(eq(B.id, U.buildingId), eq(B.tenantId, U.tenantId)))
      .where(and(inArray(U.tenantId, tenantIds), inArray(U.ownerContactId, contactIds)))
      .orderBy(asc(B.name)),
  ]);
  const tenantName = new Map(tenants.map((x) => [x.id, x.name]));
  const contact = new Map(contacts.map((x) => [x.id, x]));
  return links.map((l) => ({
    tenantId: l.tenantId,
    tenantName: tenantName.get(l.tenantId) ?? '',
    contactId: l.contactId,
    contactName: `${contact.get(l.contactId)?.firstName ?? ''} ${contact.get(l.contactId)?.lastName ?? ''}`.trim(),
    buildings: buildings.filter((b) => b.tenantId === l.tenantId && b.contactId === l.contactId).map((b) => ({ id: b.id, name: b.name })),
  }));
}

export async function portalMe(db: Db, portal: PortalContext, account: Account) {
  return { account: publicAccount(account), links: await describeLinks(db, portal.links) };
}
