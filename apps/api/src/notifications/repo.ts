import { type Db, schema } from '@domar/db';
import type { NotificationKind } from '@domar/domain';
import { and, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { notFound } from '../errors.js';
import type { PortalContext } from '../portal/context.js';
import type { TenantContext } from '../tenant-context.js';
import { notificationText, type NotificationInput } from './text.js';

const N = schema.notifications; const PS = schema.pushSubscriptions;
const OCL = schema.ownerContactLinks; const U = schema.users;

export type NotificationRow = { id: string; kind: NotificationKind; title: string; body: string; link: string; createdAt: Date; readAt: Date | null };
export type SubscriptionRow = typeof PS.$inferSelect;

interface NotificationBody { kind: NotificationKind; title: string; body: string; link: string }

/**
 * Exactly one recipient, enforced by the compiler as well as by `notifications_recipient_chk`. A
 * shape carrying both — or neither — is a trigger's bug, and a `500` from a check constraint is a
 * poor way to learn about it.
 */
export type NewNotification =
  | (NotificationBody & { ownerAccountId: string; userId?: never })
  | (NotificationBody & { userId: string; ownerAccountId?: never });

const PUBLIC_COLUMNS = { id: N.id, kind: N.kind, title: N.title, body: N.body, link: N.link, createdAt: N.createdAt, readAt: N.readAt };

/**
 * The one writer. Always called inside the transaction of the event that caused it (plan addendum 2),
 * so a rolled-back publish leaves no notification behind. Never throws on an empty list: a trigger
 * for a building whose owners have no portal account writes nothing and says nothing.
 */
export async function notify(tx: Db, ctx: TenantContext, rows: NewNotification[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(N).values(rows.map((r) => ({
    tenantId: ctx.tenantId,
    ownerAccountId: r.ownerAccountId ?? null,
    userId: r.userId ?? null,
    kind: r.kind, title: r.title, body: r.body, link: r.link,
  })));
}

/** contactId → the owner accounts linked to it in this tenant. Empty for a contact nobody claimed. */
export async function ownerAccountsByContact(tx: Db, ctx: TenantContext, contactIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const ids = [...new Set(contactIds)];
  if (ids.length === 0) return out;
  const rows = await tx.select({ contactId: OCL.contactId, ownerAccountId: OCL.ownerAccountId }).from(OCL)
    .where(and(eq(OCL.tenantId, ctx.tenantId), inArray(OCL.contactId, ids)));
  for (const r of rows) out.set(r.contactId, [...(out.get(r.contactId) ?? []), r.ownerAccountId]);
  return out;
}

/** Spec §9's manager side: the active users who can act on it. A technician has no bell. */
export async function staffRecipients(tx: Db, ctx: TenantContext): Promise<string[]> {
  const rows = await tx.select({ id: U.id }).from(U)
    .where(and(eq(U.tenantId, ctx.tenantId), eq(U.isActive, true), inArray(U.role, ['owner', 'accountant'])));
  return rows.map((r) => r.id);
}

/** One row per (contact's owner account); a contact with two accounts gets two, a contact with none gets none. */
export async function notifyOwners(tx: Db, ctx: TenantContext, items: { contactId: string; input: NotificationInput }[]): Promise<void> {
  const accounts = await ownerAccountsByContact(tx, ctx, items.map((i) => i.contactId));
  const rows: NewNotification[] = [];
  for (const item of items) {
    const text = notificationText(item.input);
    for (const ownerAccountId of accounts.get(item.contactId) ?? []) rows.push({ ownerAccountId, ...text });
  }
  await notify(tx, ctx, rows);
}

export async function notifyStaff(tx: Db, ctx: TenantContext, input: NotificationInput): Promise<void> {
  const text = notificationText(input);
  const users = await staffRecipients(tx, ctx);
  await notify(tx, ctx, users.map((userId) => ({ userId, ...text })));
}

const NOTIFICATION_LIMIT = 50;

export async function listForUser(db: Db, ctx: TenantContext): Promise<{ rows: NotificationRow[]; unread: number }> {
  const [rows, [unread]] = await Promise.all([
    db.select(PUBLIC_COLUMNS).from(N)
      .where(and(eq(N.tenantId, ctx.tenantId), eq(N.userId, ctx.userId!)))
      // `created_at` ties for rows written by one `notify()` call (`now()` is transaction-wide);
      // `seq` — like `legal_events.seq` — is the insertion-order tie-break.
      .orderBy(desc(N.createdAt), desc(N.seq)).limit(NOTIFICATION_LIMIT),
    db.select({ n: sql<number>`count(*)::int` }).from(N)
      .where(and(eq(N.tenantId, ctx.tenantId), eq(N.userId, ctx.userId!), isNull(N.readAt))),
  ]);
  return { rows, unread: unread?.n ?? 0 };
}

export async function markUserRead(db: Db, ctx: TenantContext, id: string): Promise<void> {
  const [row] = await db.update(N).set({ readAt: new Date() })
    .where(and(eq(N.tenantId, ctx.tenantId), eq(N.userId, ctx.userId!), eq(N.id, id))).returning({ id: N.id });
  // Somebody else's row is a 404, never a 403: the bell must not confirm that an id exists.
  if (!row) throw notFound('Notification');
}

export async function markAllUserRead(db: Db, ctx: TenantContext): Promise<void> {
  await db.update(N).set({ readAt: new Date() })
    .where(and(eq(N.tenantId, ctx.tenantId), eq(N.userId, ctx.userId!), isNull(N.readAt)));
}

/**
 * Scoped to one link when the portal names the contact it is showing, across every link the account
 * holds when it does not. Every portal page reads one `?contactId=`, and a row carries nothing to
 * switch that selection by, so a cross-tenant listing would offer rows the app cannot open.
 */
export async function listForOwner(db: Db, portal: PortalContext, contactId?: string): Promise<{ rows: NotificationRow[]; unread: number }> {
  const tenantIds = ownerTenantIds(portal, contactId);
  if (tenantIds.length === 0) return { rows: [], unread: 0 };
  const scope = and(eq(N.ownerAccountId, portal.ownerAccountId), inArray(N.tenantId, tenantIds));
  const [rows, [unread]] = await Promise.all([
    db.select(PUBLIC_COLUMNS).from(N).where(scope).orderBy(desc(N.createdAt), desc(N.seq)).limit(NOTIFICATION_LIMIT),
    db.select({ n: sql<number>`count(*)::int` }).from(N).where(and(scope, isNull(N.readAt))),
  ]);
  return { rows, unread: unread?.n ?? 0 };
}

/**
 * The tenants a link revocation has not yet dropped — the same scope `listForOwner` reads by. A
 * `contactId` the account holds no link to narrows it to nothing, exactly like a revoked link does.
 */
function ownerTenantIds(portal: PortalContext, contactId?: string): string[] {
  const links = contactId === undefined ? portal.links : portal.links.filter((l) => l.contactId === contactId);
  return [...new Set(links.map((l) => l.tenantId))];
}

/** By id, across every link: the id came off the account's own listing, whichever link showed it. */
export async function markOwnerRead(db: Db, portal: PortalContext, id: string): Promise<void> {
  const tenantIds = ownerTenantIds(portal);
  // A row from a tenant the account is no longer linked to is a 404, exactly like one that never
  // existed: `listForOwner` never shows it, so this must never confirm it exists either.
  if (tenantIds.length === 0) throw notFound('Notification');
  const [row] = await db.update(N).set({ readAt: new Date() })
    .where(and(eq(N.ownerAccountId, portal.ownerAccountId), inArray(N.tenantId, tenantIds), eq(N.id, id))).returning({ id: N.id });
  if (!row) throw notFound('Notification');
}

/** Scoped the same way the listing is: "mark all read" clears what the bell is showing, no more. */
export async function markAllOwnerRead(db: Db, portal: PortalContext, contactId?: string): Promise<void> {
  const tenantIds = ownerTenantIds(portal, contactId);
  if (tenantIds.length === 0) return;
  await db.update(N).set({ readAt: new Date() })
    .where(and(eq(N.ownerAccountId, portal.ownerAccountId), inArray(N.tenantId, tenantIds), isNull(N.readAt)));
}

export interface NewSubscription { endpoint: string; p256dh: string; auth: string; userAgent?: string | undefined }

/**
 * How many browsers one owner account may keep registered at once. Delivery fans out to every one
 * of them, so an uncapped list is a way for one account to make its own rows cost the whole queue
 * minutes of wall-clock; ten is well past a phone, a tablet and a desktop each with two browsers.
 * When the cap is reached the *least recently seen* row goes — that is what `last_seen_at` is for:
 * the browser that has not re-subscribed in longest is the one most likely to be gone already.
 */
export const MAX_SUBSCRIPTIONS_PER_ACCOUNT = 10;

/**
 * One row per endpoint (the unique index), so a browser that rotates its keys updates in place.
 * Keyed on the caller's own account alone — `push_subscriptions` has no `tenant_id` column, exactly
 * like `owner_sessions`: an owner account is deliberately cross-tenant.
 * No `writeAudit` here: `audit_logs.tenant_id` is `NOT NULL` and this row has no tenant to write one
 * under — same as `owner_sessions`, which is likewise never audited. Not an omission.
 */
export async function upsertSubscription(db: Db, portal: PortalContext, input: NewSubscription): Promise<void> {
  await db.insert(PS).values({
    ownerAccountId: portal.ownerAccountId,
    endpoint: input.endpoint, p256dh: input.p256dh, auth: input.auth,
    userAgent: input.userAgent ?? null,
  }).onConflictDoUpdate({
    target: PS.endpoint,
    set: {
      ownerAccountId: portal.ownerAccountId,
      p256dh: input.p256dh, auth: input.auth, userAgent: input.userAgent ?? null, lastSeenAt: new Date(),
    },
  });
  await evictOldestSubscriptions(db, portal.ownerAccountId);
}

/** Keeps the `MAX_SUBSCRIPTIONS_PER_ACCOUNT` most recently seen rows and drops the rest. */
async function evictOldestSubscriptions(db: Db, ownerAccountId: string): Promise<void> {
  const rows = await db.select({ id: PS.id }).from(PS).where(eq(PS.ownerAccountId, ownerAccountId))
    // `created_at` breaks the tie for two rows stamped inside one transaction, exactly like `seq` does
    // for the bell; without it the row evicted would be whichever the planner happened to return.
    .orderBy(desc(PS.lastSeenAt), desc(PS.createdAt)).limit(MAX_SUBSCRIPTIONS_PER_ACCOUNT + 1);
  if (rows.length <= MAX_SUBSCRIPTIONS_PER_ACCOUNT) return;
  const keep = rows.slice(0, MAX_SUBSCRIPTIONS_PER_ACCOUNT).map((r) => r.id);
  await db.delete(PS).where(and(eq(PS.ownerAccountId, ownerAccountId), notInArray(PS.id, keep)));
}

/** The caller's own endpoint only; an endpoint that is not theirs simply matches nothing. */
export async function removeSubscription(db: Db, portal: PortalContext, endpoint: string): Promise<void> {
  await db.delete(PS).where(and(eq(PS.ownerAccountId, portal.ownerAccountId), eq(PS.endpoint, endpoint)));
}

/**
 * Delivery's lookup: by account, deliberately across tenants. Most recently seen first and capped
 * at the same number the writer enforces, so a row left over from before the cap existed — or from
 * a race between two subscribes — still cannot widen one row's fan-out.
 */
export async function subscriptionsFor(db: Db, ownerAccountId: string): Promise<SubscriptionRow[]> {
  return db.select().from(PS).where(eq(PS.ownerAccountId, ownerAccountId))
    .orderBy(desc(PS.lastSeenAt), desc(PS.createdAt)).limit(MAX_SUBSCRIPTIONS_PER_ACCOUNT);
}

export async function deleteSubscriptionByEndpoint(db: Db, endpoint: string): Promise<void> {
  await db.delete(PS).where(eq(PS.endpoint, endpoint));
}
