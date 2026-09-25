import { sql } from 'drizzle-orm';
import { bigserial, check, index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { ownerAccounts } from './portal.js';
import { tenants } from './tenant.js';

/** Spec §9's trigger list, plus the manager-side pair (a portal request, a failed send). */
export const notificationKind = pgEnum('notification_kind', [
  'invoice_published', 'reminder_created', 'assembly_invited', 'assembly_voting_opened',
  'maintenance_status', 'maintenance_request_created', 'delivery_failed',
]);

const tenantRef = () => uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' });

/**
 * One browser, one row. `endpoint` is globally unique because that is what the Web Push service
 * hands out, so a re-subscription updates the keys in place instead of growing a second row. Not
 * tenant-scoped, like `owner_sessions`: an owner account is deliberately cross-tenant, and delivery
 * looks the row up by `owner_account_id` alone.
 */
export const pushSubscriptions = pgTable('push_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerAccountId: uuid('owner_account_id').notNull().references(() => ownerAccounts.id, { onDelete: 'cascade' }),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('push_subscriptions_account_idx').on(t.ownerAccountId),
]);

/**
 * One row per recipient (plan addendum 1): `read_at` and `delivered_at` are per person, so a shared
 * row would have to be rewritten by every reader. `body` never reaches a push payload — spec §11
 * allows title and link only — and this table has no money column at all.
 */
export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  ownerAccountId: uuid('owner_account_id').references(() => ownerAccounts.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  kind: notificationKind('kind').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  /** An in-app path, never an absolute URL: the service worker resolves it against its own origin. */
  link: text('link').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp('read_at', { withTimezone: true }),
  /** Stamped by the drain job before it sends anything, so a crash cannot double-send. */
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  deliveryError: text('delivery_error'),
  /**
   * Insertion order, like `legal_events.seq`: rows written by one `notify()` call — or by two
   * `notify()` calls inside one transaction — share `created_at` (`now()` is fixed for the whole
   * transaction), so the tie-break the bell orders by has to be insertion order, not a random uuid.
   */
  seq: bigserial('seq', { mode: 'number' }).notNull(),
}, (t) => [
  index('notifications_tenant_user_idx').on(t.tenantId, t.userId, t.createdAt),
  index('notifications_tenant_account_idx').on(t.tenantId, t.ownerAccountId, t.createdAt),
  // The drain job's only query: the undelivered tail in insertion order. It claims by `seq`, not by
  // `created_at` — rows written by one transaction share `created_at` — so the index is on `seq`,
  // or every chunk would read and sort the whole pending set instead of the ten rows it takes.
  index('notifications_pending_idx').on(t.seq).where(sql`delivered_at is null`),
  check('notifications_recipient_chk', sql`num_nonnulls(${t.ownerAccountId}, ${t.userId}) = 1`),
]);
