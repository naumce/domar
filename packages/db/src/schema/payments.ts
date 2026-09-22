import { bigint, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { buildings } from './building.js';
import { contacts } from './contact.js';
import { invoices } from './billing.js';
import { tenants } from './tenant.js';

export const paymentMethod = pgEnum('payment_method', ['cash', 'bank_transfer', 'card', 'cheque', 'other']);
export const paymentStatus = pgEnum('payment_status', ['completed', 'voided']);
export const matchStatus = pgEnum('match_status', ['unmatched', 'suggested', 'matched', 'ignored']);

const money = (name: string) => bigint(name, { mode: 'number' });
const tenantRef = () => uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' });
const ts = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const bankStatements = pgTable('bank_statements', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  buildingId: uuid('building_id').notNull().references(() => buildings.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  format: text('format').notNull(),
  accountNumber: text('account_number'),
  lineCount: integer('line_count').notNull().default(0),
  matchedCount: integer('matched_count').notNull().default(0),
  skippedCount: integer('skipped_count').notNull().default(0),
  importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
}, (t) => [index('bank_statements_tenant_building_idx').on(t.tenantId, t.buildingId, t.importedAt)]);

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  buildingId: uuid('building_id').notNull().references(() => buildings.id, { onDelete: 'cascade' }),
  invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'restrict' }),
  contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'restrict' }),
  amountMinor: money('amount_minor').notNull(),
  method: paymentMethod('method').notNull(),
  paidAt: timestamp('paid_at', { withTimezone: true }).notNull(),
  reference: text('reference'),
  note: text('note'),
  statementLineId: uuid('statement_line_id'),
  status: paymentStatus('status').notNull().default('completed'),
  voidReason: text('void_reason'),
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  createdBy: uuid('created_by'),
  ...ts(),
}, (t) => [
  index('payments_tenant_building_paid_idx').on(t.tenantId, t.buildingId, t.paidAt),
  index('payments_tenant_invoice_idx').on(t.tenantId, t.invoiceId),
  index('payments_tenant_contact_paid_idx').on(t.tenantId, t.contactId, t.paidAt),
]);

export const statementLines = pgTable('statement_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  statementId: uuid('statement_id').notNull().references(() => bankStatements.id, { onDelete: 'cascade' }),
  buildingId: uuid('building_id').notNull().references(() => buildings.id, { onDelete: 'cascade' }),
  lineNo: integer('line_no').notNull(),
  bookedAt: timestamp('booked_at', { withTimezone: true }).notNull(),
  amountMinor: money('amount_minor').notNull(),
  counterparty: text('counterparty'),
  reference: text('reference'),
  raw: text('raw').notNull(),
  fingerprint: text('fingerprint').notNull(),
  matchStatus: matchStatus('match_status').notNull().default('unmatched'),
  confidence: text('confidence'),
  suggestedInvoiceId: uuid('suggested_invoice_id').references(() => invoices.id, { onDelete: 'set null' }),
  paymentId: uuid('payment_id').references(() => payments.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('statement_lines_tenant_statement_idx').on(t.tenantId, t.statementId, t.lineNo),
  index('statement_lines_tenant_building_status_idx').on(t.tenantId, t.buildingId, t.matchStatus),
  uniqueIndex('statement_lines_fingerprint_idx').on(t.buildingId, t.fingerprint),
]);
