import { bigint, boolean, char, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { tenants } from './tenant.js';

/**
 * The fixed set of account slots the journal derivation needs, and the only ones (spec §3). A tenant
 * maps its own codes onto them, which is what makes one export feed Pantheon, Logik or an
 * accountant's own Excel without the product knowing any of them.
 */
export const accountSlot = pgEnum('account_slot', [
  'owner_receivable', 'revenue_service', 'revenue_management_fee', 'revenue_reserve_fund',
  'vat_output', 'cash_regular', 'cash_reserve', 'expense_default', 'opening_balance',
]);

const money = (name: string) => bigint(name, { mode: 'number' });
const tenantRef = () => uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' });
const ts = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const accountCodes = pgTable('account_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  slot: accountSlot('slot').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  ...ts(),
}, (t) => [uniqueIndex('account_codes_tenant_slot_idx').on(t.tenantId, t.slot)]);

/**
 * Closing a period is advisory, not a lock (spec §5): nothing else in the system gains a refusal.
 * The row records what the file said when it was filed, so a posting that arrives afterwards can be
 * reported as a prior-period adjustment rather than silently changing an already-posted month.
 */
export const accountingPeriods = pgTable('accounting_periods', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  period: char('period', { length: 7 }).notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }).notNull().defaultNow(),
  closedBy: uuid('closed_by').references(() => users.id, { onDelete: 'set null' }),
  debitTotalMinor: money('debit_total_minor').notNull().default(0),
  creditTotalMinor: money('credit_total_minor').notNull().default(0),
  entryCount: integer('entry_count').notNull().default(0),
  ...ts(),
}, (t) => [
  uniqueIndex('accounting_periods_tenant_period_idx').on(t.tenantId, t.period),
  index('accounting_periods_tenant_closed_idx').on(t.tenantId, t.closedAt),
]);
