import { sql } from 'drizzle-orm';
import { bigint, boolean, char, index, integer, jsonb, numeric, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { buildings, shareBasis, units } from './building.js';
import { documents, suppliers } from './compliance.js';
import { contacts } from './contact.js';
import { taxRates } from './tax-rate.js';
import { tenants } from './tenant.js';

export const pricingModel = pgEnum('pricing_model', ['fixed_per_unit', 'per_m2', 'shared_total']);
export const fund = pgEnum('fund', ['regular', 'reserve']);
export const serviceFrequency = pgEnum('service_frequency', ['monthly', 'every_n_months']);
export const reserveBasis = pgEnum('reserve_basis', ['per_unit', 'per_m2']);
export const periodStatus = pgEnum('period_status', ['open', 'generated', 'published']);
export const lineSource = pgEnum('line_source', ['auto', 'manual']);
export const invoiceStatus = pgEnum('invoice_status', ['draft', 'published', 'partially_paid', 'paid', 'cancelled']);
export const lineKind = pgEnum('line_kind', ['service', 'manual', 'reserve_fund', 'management_fee']);
export const postingAccount = pgEnum('posting_account', ['owner', 'fund']);
export const postingKind = pgEnum('posting_kind', ['charge', 'payment', 'expense', 'adjustment', 'opening']);
export const periodKind = pgEnum('period_kind', ['regular', 'extraordinary']);

const money = (name: string) => bigint(name, { mode: 'number' });
const tenantRef = () => uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' });
const ts = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const services = pgTable('services', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  name: text('name').notNull(),
  category: text('category'),
  description: text('description'),
  pricing: pricingModel('pricing').notNull(),
  defaultPriceMinor: money('default_price_minor').notNull().default(0),
  taxRateId: uuid('tax_rate_id').references(() => taxRates.id, { onDelete: 'set null' }),
  appliesTo: text('applies_to').array().notNull().default(sql`'{}'::text[]`),
  recurring: boolean('recurring').notNull().default(true),
  isActive: boolean('is_active').notNull().default(true),
  ...ts(),
}, (t) => [index('services_tenant_idx').on(t.tenantId, t.name)]);

export const buildingServices = pgTable('building_services', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  buildingId: uuid('building_id').notNull().references(() => buildings.id, { onDelete: 'cascade' }),
  serviceId: uuid('service_id').notNull().references(() => services.id, { onDelete: 'restrict' }),
  priceMinor: money('price_minor'),
  pricing: pricingModel('pricing'),
  frequency: serviceFrequency('frequency').notNull().default('monthly'),
  intervalMonths: integer('interval_months').notNull().default(1),
  startsPeriod: char('starts_period', { length: 7 }).notNull(),
  endsPeriod: char('ends_period', { length: 7 }),
  isActive: boolean('is_active').notNull().default(true),
  ...ts(),
}, (t) => [index('building_services_tenant_building_idx').on(t.tenantId, t.buildingId), uniqueIndex('building_services_unique_idx').on(t.buildingId, t.serviceId)]);

export const reserveFundSettings = pgTable('reserve_fund_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  buildingId: uuid('building_id').notNull().references(() => buildings.id, { onDelete: 'cascade' }),
  basis: reserveBasis('basis').notNull().default('per_unit'),
  amountMinor: money('amount_minor').notNull().default(0),
  appliesTo: text('applies_to').array().notNull().default(sql`'{}'::text[]`),
  active: boolean('active').notNull().default(false),
  ...ts(),
}, (t) => [index('reserve_fund_settings_tenant_idx').on(t.tenantId), uniqueIndex('reserve_fund_settings_building_idx').on(t.buildingId)]);

export const expenses = pgTable('expenses', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  buildingId: uuid('building_id').notNull().references(() => buildings.id, { onDelete: 'cascade' }),
  fund: fund('fund').notNull(),
  description: text('description').notNull(),
  supplierText: text('supplier_text'),
  supplierId: uuid('supplier_id').references(() => suppliers.id, { onDelete: 'set null' }),
  documentId: uuid('document_id').references(() => documents.id, { onDelete: 'set null' }),
  amountMinor: money('amount_minor').notNull(),
  paidAt: timestamp('paid_at', { withTimezone: true }).notNull(),
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  voidReason: text('void_reason'),
  ...ts(),
}, (t) => [index('expenses_tenant_building_idx').on(t.tenantId, t.buildingId, t.paidAt)]);

export const billingPeriods = pgTable('billing_periods', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  buildingId: uuid('building_id').notNull().references(() => buildings.id, { onDelete: 'cascade' }),
  period: char('period', { length: 7 }).notNull(),
  status: periodStatus('status').notNull().default('open'),
  /** `extraordinary` = an Art. 47(5) one-off; it carries a single manual line and no automatic ones. */
  kind: periodKind('kind').notNull().default('regular'),
  /** Set only on extraordinary periods: the basis the engine splits that one line by (plan addendum 17). */
  distributionBasis: shareBasis('distribution_basis'),
  managementFeeMinor: money('management_fee_minor').notNull().default(0),
  managementFeeTaxRateBp: integer('management_fee_tax_rate_bp').notNull().default(0),
  managementFeeAppliesTo: text('management_fee_applies_to').array().notNull().default(sql`'{apartment,commercial}'::text[]`),
  numberPrefix: text('number_prefix').notNull().default('INV-'),
  numberSuffix: text('number_suffix').notNull().default('/{year}'),
  currency: char('currency', { length: 3 }).notNull(),
  issuedAt: timestamp('issued_at', { withTimezone: true }),
  dueAt: timestamp('due_at', { withTimezone: true }),
  generatedAt: timestamp('generated_at', { withTimezone: true }),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  warnings: jsonb('warnings').notNull().default(sql`'[]'::jsonb`),
  ...ts(),
}, (t) => [
  index('billing_periods_tenant_idx').on(t.tenantId, t.buildingId, t.period),
  // Partial: one *regular* period per building per month, any number of extraordinary ones (addendum 15).
  uniqueIndex('billing_periods_building_regular_period_idx').on(t.buildingId, t.period).where(sql`${t.kind} = 'regular'`),
]);

export const periodLines = pgTable('period_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  periodId: uuid('period_id').notNull().references(() => billingPeriods.id, { onDelete: 'cascade' }),
  serviceId: uuid('service_id').references(() => services.id, { onDelete: 'set null' }),
  description: text('description').notNull(),
  pricing: pricingModel('pricing').notNull(),
  quantity: numeric('quantity', { precision: 12, scale: 3 }).notNull().default('1'),
  unitPriceMinor: money('unit_price_minor').notNull(),
  taxRateBp: integer('tax_rate_bp').notNull().default(0),
  appliesTo: text('applies_to').array().notNull().default(sql`'{}'::text[]`),
  fund: fund('fund').notNull().default('regular'),
  source: lineSource('source').notNull().default('manual'),
  note: text('note'),
  sortOrder: integer('sort_order').notNull().default(0),
  ...ts(),
}, (t) => [index('period_lines_tenant_period_idx').on(t.tenantId, t.periodId, t.sortOrder)]);

export const invoices = pgTable('invoices', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  periodId: uuid('period_id').notNull().references(() => billingPeriods.id, { onDelete: 'cascade' }),
  buildingId: uuid('building_id').notNull().references(() => buildings.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'restrict' }),
  number: text('number'),
  status: invoiceStatus('status').notNull().default('draft'),
  currency: char('currency', { length: 3 }).notNull(),
  unitIds: jsonb('unit_ids').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  subtotalMinor: money('subtotal_minor').notNull(),
  taxMinor: money('tax_minor').notNull(),
  totalMinor: money('total_minor').notNull(),
  previousBalanceMinor: money('previous_balance_minor').notNull().default(0),
  amountDueMinor: money('amount_due_minor').notNull(),
  reserveFundBuildingBalanceMinor: money('reserve_fund_building_balance_minor').notNull().default(0),
  issuedAt: timestamp('issued_at', { withTimezone: true }),
  dueAt: timestamp('due_at', { withTimezone: true }),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  ...ts(),
}, (t) => [
  index('invoices_tenant_period_idx').on(t.tenantId, t.periodId),
  index('invoices_tenant_contact_idx').on(t.tenantId, t.contactId),
  uniqueIndex('invoices_tenant_number_idx').on(t.tenantId, t.number),
  index('invoices_tenant_status_due_idx').on(t.tenantId, t.status, t.dueAt),
  index('invoices_tenant_building_idx').on(t.tenantId, t.buildingId),
]);

export const invoiceLines = pgTable('invoice_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  invoiceId: uuid('invoice_id').notNull().references(() => invoices.id, { onDelete: 'cascade' }),
  periodLineId: uuid('period_line_id').references(() => periodLines.id, { onDelete: 'set null' }),
  kind: lineKind('kind').notNull(),
  description: text('description').notNull(),
  fund: fund('fund').notNull(),
  unitId: uuid('unit_id').references(() => units.id, { onDelete: 'set null' }),
  unitLabel: text('unit_label').notNull().default(''),
  buildingWideNetMinor: money('building_wide_net_minor').notNull(),
  ownerNetMinor: money('owner_net_minor').notNull(),
  taxRateBp: integer('tax_rate_bp').notNull().default(0),
  ownerTaxMinor: money('owner_tax_minor').notNull(),
  ownerGrossMinor: money('owner_gross_minor').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
}, (t) => [index('invoice_lines_tenant_invoice_idx').on(t.tenantId, t.invoiceId, t.sortOrder)]);

export const postings = pgTable('postings', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  buildingId: uuid('building_id').notNull().references(() => buildings.id, { onDelete: 'cascade' }),
  account: postingAccount('account').notNull(),
  fund: fund('fund').notNull(),
  contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'restrict' }),
  kind: postingKind('kind').notNull(),
  amountMinor: money('amount_minor').notNull(),
  refType: text('ref_type').notNull(),
  refId: uuid('ref_id'),
  period: char('period', { length: 7 }),
  bookedAt: timestamp('booked_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('postings_tenant_building_fund_idx').on(t.tenantId, t.buildingId, t.fund, t.account),
  index('postings_tenant_contact_idx').on(t.tenantId, t.contactId, t.bookedAt),
  index('postings_tenant_ref_idx').on(t.tenantId, t.refType, t.refId),
]);

export const invoiceSequences = pgTable('invoice_sequences', {
  tenantId: tenantRef(),
  year: integer('year').notNull(),
  next: integer('next').notNull().default(1),
}, (t) => [primaryKey({ name: 'invoice_sequences_pk', columns: [t.tenantId, t.year] })]);
