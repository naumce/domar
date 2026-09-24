import { sql } from 'drizzle-orm';
import { bigint, boolean, date, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { buildings } from './building.js';
import { tenants } from './tenant.js';

/** Spec §3: the kinds the compliance screen reads. Append only — an existing label is never renamed. */
export const legalEventKind = pgEnum('legal_event_kind', [
  'invoice_published', 'reminder_sent', 'assembly_invited', 'assembly_held',
  'annual_report_issued', 'handover_report_issued', 'fund_statement_available', 'extraordinary_cost_distributed',
]);
export const documentKind = pgEnum('document_kind', ['contract', 'minutes', 'report', 'invoice_supplier', 'photo', 'other']);
export const contractKind = pgEnum('contract_kind', ['management', 'service', 'insurance', 'other']);

const money = (name: string) => bigint(name, { mode: 'number' });
const tenantRef = () => uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' });
const ts = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Append-only evidence of a legal duty (spec §3, §11). Nothing in the API updates or deletes a row
 * here; `apps/api/src/legal-events.ts` exports a writer and readers and no mutator.
 */
export const legalEvents = pgTable('legal_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  buildingId: uuid('building_id').notNull().references(() => buildings.id, { onDelete: 'cascade' }),
  kind: legalEventKind('kind').notNull(),
  refType: text('ref_type').notNull(),
  refId: uuid('ref_id'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  dueAt: timestamp('due_at', { withTimezone: true }),
  /** Who, how delivered, which message and document ids — the shapes are in the plan's addendum 2. */
  evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('legal_events_tenant_building_idx').on(t.tenantId, t.buildingId, t.occurredAt),
  index('legal_events_tenant_kind_idx').on(t.tenantId, t.kind, t.occurredAt),
]);

/**
 * File metadata. The bytes live under `DATA_DIR/<storage_key>`, outside the web root (spec §11);
 * `storage_key` is unique so two rows can never claim the same file and a delete free one of them.
 */
export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  /** null = a tenant-level document; those are never visible to the portal. */
  buildingId: uuid('building_id').references(() => buildings.id, { onDelete: 'cascade' }),
  kind: documentKind('kind').notNull(),
  title: text('title').notNull(),
  fileName: text('file_name').notNull(),
  mime: text('mime').notNull(),
  sizeBytes: money('size_bytes').notNull(),
  storageKey: text('storage_key').notNull(),
  sha256: text('sha256').notNull(),
  uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('documents_tenant_building_idx').on(t.tenantId, t.buildingId, t.createdAt),
  index('documents_tenant_kind_idx').on(t.tenantId, t.kind, t.createdAt),
  uniqueIndex('documents_storage_key_idx').on(t.storageKey),
]);

export const suppliers = pgTable('suppliers', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  name: text('name').notNull(),
  companyNumber: text('company_number'),
  vatNumber: text('vat_number'),
  email: text('email'),
  phone: text('phone'),
  iban: text('iban'),
  notes: text('notes'),
  isActive: boolean('is_active').notNull().default(true),
  ...ts(),
}, (t) => [index('suppliers_tenant_idx').on(t.tenantId, t.name)]);

/** `supplier_id` null = the manager's own management contract with the building (spec §4). */
export const buildingContracts = pgTable('building_contracts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  buildingId: uuid('building_id').notNull().references(() => buildings.id, { onDelete: 'cascade' }),
  supplierId: uuid('supplier_id').references(() => suppliers.id, { onDelete: 'restrict' }),
  kind: contractKind('kind').notNull(),
  title: text('title').notNull(),
  startsOn: date('starts_on').notNull(),
  endsOn: date('ends_on'),
  noticeDays: integer('notice_days').notNull().default(0),
  amountMinor: money('amount_minor'),
  documentId: uuid('document_id').references(() => documents.id, { onDelete: 'set null' }),
  ...ts(),
}, (t) => [
  index('building_contracts_tenant_building_idx').on(t.tenantId, t.buildingId, t.startsOn),
  index('building_contracts_tenant_kind_idx').on(t.tenantId, t.kind),
]);
