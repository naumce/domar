import { sql } from 'drizzle-orm';
import { bigint, check, index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { expenses, fund } from './billing.js';
import { buildings, units } from './building.js';
import { documents, suppliers } from './compliance.js';
import { contacts } from './contact.js';
import { tenants } from './tenant.js';

/** Spec §8. `done` and `rejected` are terminal: a request is never reopened (plan addendum 2). */
export const maintenanceStatus = pgEnum('maintenance_status', ['new', 'triaged', 'assigned', 'in_progress', 'done', 'rejected']);
export const maintenancePriority = pgEnum('maintenance_priority', ['low', 'normal', 'high', 'urgent']);
/** The country pack's `maintenanceCategories` carries the labels for exactly these keys (addendum 14). */
export const maintenanceCategory = pgEnum('maintenance_category', ['plumbing', 'electrical', 'lift', 'heating', 'cleaning', 'common_area', 'other']);
export const maintenanceEventKind = pgEnum('maintenance_event_kind', ['created', 'status_changed', 'assigned', 'comment', 'photo_added']);
/** `owner` events are what the portal's feed shows; everything written through the portal is `owner`. */
export const maintenanceVisibility = pgEnum('maintenance_visibility', ['internal', 'owner']);

const money = (name: string) => bigint(name, { mode: 'number' });
const tenantRef = () => uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' });
const ts = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Spec §8: one owner request. `reported_by_*` is exactly one of the two, enforced by the check —
 * neither column is ever nulled by a delete (`no action`), so the check holds for the row's life
 * and a reporter cannot be deleted out from under it (addendum 1).
 * `cost_minor`/`fund`/`expense_id` are filled only when the request is closed with a cost, and the
 * expense itself is written by the existing `createExpense` flow (spec §11, addendum 5).
 */
export const maintenanceRequests = pgTable('maintenance_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  buildingId: uuid('building_id').notNull().references(() => buildings.id, { onDelete: 'cascade' }),
  /** null = the common parts rather than one flat. */
  unitId: uuid('unit_id').references(() => units.id, { onDelete: 'set null' }),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  category: maintenanceCategory('category').notNull(),
  priority: maintenancePriority('priority').notNull().default('normal'),
  status: maintenanceStatus('status').notNull().default('new'),
  reportedByUserId: uuid('reported_by_user_id').references(() => users.id, { onDelete: 'no action' }),
  reportedByContactId: uuid('reported_by_contact_id').references(() => contacts.id, { onDelete: 'no action' }),
  /** A user of this tenant with role technician, accountant or owner (checked in the API). */
  assigneeUserId: uuid('assignee_user_id').references(() => users.id, { onDelete: 'set null' }),
  supplierId: uuid('supplier_id').references(() => suppliers.id, { onDelete: 'set null' }),
  fund: fund('fund'),
  costMinor: money('cost_minor'),
  expenseId: uuid('expense_id').references(() => expenses.id, { onDelete: 'set null' }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  ...ts(),
}, (t) => [
  index('maintenance_requests_tenant_building_idx').on(t.tenantId, t.buildingId, t.createdAt),
  index('maintenance_requests_tenant_status_idx').on(t.tenantId, t.status, t.createdAt),
  index('maintenance_requests_tenant_assignee_idx').on(t.tenantId, t.assigneeUserId, t.createdAt),
  index('maintenance_requests_tenant_contact_idx').on(t.tenantId, t.reportedByContactId, t.createdAt),
  check('maintenance_requests_reporter_chk', sql`num_nonnulls(${t.reportedByUserId}, ${t.reportedByContactId}) = 1`),
]);

/** The feed: one row per status change, assignment, comment and photo (spec §8). Never updated. */
export const maintenanceEvents = pgTable('maintenance_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  maintenanceRequestId: uuid('maintenance_request_id').notNull().references(() => maintenanceRequests.id, { onDelete: 'cascade' }),
  kind: maintenanceEventKind('kind').notNull(),
  fromStatus: maintenanceStatus('from_status'),
  toStatus: maintenanceStatus('to_status'),
  note: text('note').notNull().default(''),
  visibility: maintenanceVisibility('visibility').notNull().default('internal'),
  authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
  authorContactId: uuid('author_contact_id').references(() => contacts.id, { onDelete: 'no action' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('maintenance_events_tenant_request_idx').on(t.tenantId, t.maintenanceRequestId, t.createdAt),
  // `<=`, not `=`: `author_user_id` is `set null`, so a departed employee's notes stay unsigned (addendum 12).
  check('maintenance_events_author_chk', sql`num_nonnulls(${t.authorUserId}, ${t.authorContactId}) <= 1`),
]);

/**
 * Spec §8: "photos as documents (`kind photo`)". The join row, not a column on `documents`, so a
 * photo carries who attached it and every other document stays free of a maintenance concern.
 * `document_id` is unique and cascades: deleting the document takes the gallery entry with it.
 */
export const maintenancePhotos = pgTable('maintenance_photos', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  maintenanceRequestId: uuid('maintenance_request_id').notNull().references(() => maintenanceRequests.id, { onDelete: 'cascade' }),
  documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  uploadedByUserId: uuid('uploaded_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  uploadedByContactId: uuid('uploaded_by_contact_id').references(() => contacts.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('maintenance_photos_tenant_request_idx').on(t.tenantId, t.maintenanceRequestId, t.createdAt),
  uniqueIndex('maintenance_photos_document_idx').on(t.documentId),
]);
