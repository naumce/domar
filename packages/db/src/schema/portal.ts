import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { contacts } from './contact.js';
import { tenants } from './tenant.js';

/**
 * Owner logins. Deliberately not tenant-scoped (spec §19.1): one person may own units under two
 * management companies and must reach both with a single password. The bridge to a manager's data
 * is `owner_contact_links`, never this row.
 */
export const ownerAccounts = pgTable('owner_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Server-side portal sessions, cookie `domar_owner`. Not tenant-scoped, like `sessions`. */
export const ownerSessions = pgTable('owner_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: text('token_hash').notNull().unique(),
  ownerAccountId: uuid('owner_account_id').notNull().references(() => ownerAccounts.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  userAgent: text('user_agent'),
  ip: text('ip'),
}, (t) => [index('owner_sessions_account_idx').on(t.ownerAccountId)]);

/** The only bridge between an owner login and a manager's data. Unique per (account, contact). */
export const ownerContactLinks = pgTable('owner_contact_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerAccountId: uuid('owner_account_id').notNull().references(() => ownerAccounts.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  // cascade, not restrict: a contact with no financial history may still be deleted, and a link to a
  // deleted contact would be a link to nothing.
  contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('owner_contact_links_tenant_contact_idx').on(t.tenantId, t.contactId),
  uniqueIndex('owner_contact_links_account_contact_idx').on(t.ownerAccountId, t.contactId),
  index('owner_contact_links_account_idx').on(t.ownerAccountId),
]);

/**
 * One invitation code. Only the sha256 hash is stored, so a database dump cannot be replayed into
 * someone's portal account. `code_hash` is unique because registration looks a code up by hash
 * alone — the request carries no tenant yet.
 */
export const portalInvites = pgTable('portal_invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  codeHash: text('code_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('portal_invites_tenant_contact_idx').on(t.tenantId, t.contactId, t.createdAt),
  uniqueIndex('portal_invites_code_hash_idx').on(t.codeHash),
]);
