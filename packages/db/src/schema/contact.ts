import { index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenant.js';

export const contactKind = pgEnum('contact_kind', ['person', 'company']);

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    kind: contactKind('kind').notNull().default('person'),
    firstName: text('first_name').notNull().default(''),
    lastName: text('last_name').notNull(),
    companyNumber: text('company_number'),
    vatNumber: text('vat_number'),
    email: text('email'),
    phone: text('phone'),
    address: text('address'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('contacts_tenant_idx').on(t.tenantId, t.lastName)],
);
