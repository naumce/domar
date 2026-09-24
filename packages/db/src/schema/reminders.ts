import { sql } from 'drizzle-orm';
import { bigint, index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { buildings } from './building.js';
import { contacts } from './contact.js';
import { tenants } from './tenant.js';

export const reminderReason = pgEnum('reminder_reason', ['consecutive', 'total']);
export const reminderChannel = pgEnum('reminder_channel', ['email', 'letter']);
export const reminderStatus = pgEnum('reminder_status', ['pending', 'sent', 'failed', 'printed']);
export const emailStatus = pgEnum('email_status', ['sent', 'failed']);

const money = (name: string) => bigint(name, { mode: 'number' });
const tenantRef = () => uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' });

/** One Art. 28 reminder. The letter PDF is rendered from `document_html` on demand, never stored. */
export const reminders = pgTable('reminders', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  buildingId: uuid('building_id').notNull().references(() => buildings.id, { onDelete: 'cascade' }),
  // restrict, like invoices and payments: a contact with reminder evidence cannot be deleted.
  contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'restrict' }),
  reason: reminderReason('reason').notNull(),
  invoiceIds: uuid('invoice_ids').array().notNull().default(sql`'{}'::uuid[]`),
  totalOutstandingMinor: money('total_outstanding_minor').notNull(),
  channel: reminderChannel('channel').notNull(),
  status: reminderStatus('status').notNull().default('pending'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  error: text('error'),
  documentHtml: text('document_html').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('reminders_tenant_building_idx').on(t.tenantId, t.buildingId, t.createdAt),
  index('reminders_tenant_contact_idx').on(t.tenantId, t.contactId, t.createdAt),
]);

/** Every outgoing message, successful or not. `to_address` because `to` is a reserved SQL keyword. */
export const emailLog = pgTable('email_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  toAddress: text('to_address').notNull(),
  subject: text('subject').notNull(),
  template: text('template').notNull(),
  refType: text('ref_type').notNull(),
  refId: uuid('ref_id'),
  status: emailStatus('status').notNull(),
  error: text('error'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('email_log_tenant_created_idx').on(t.tenantId, t.createdAt),
  index('email_log_tenant_ref_idx').on(t.tenantId, t.refType, t.refId),
]);
