import { pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: varchar('slug', { length: 64 }).notNull().unique(),
  name: text('name').notNull(),
  countryCode: varchar('country_code', { length: 2 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull(),
  locale: varchar('locale', { length: 10 }).notNull(),
  companyNumber: text('company_number'),
  vatNumber: text('vat_number'),
  address: text('address'),
  phone: text('phone'),
  email: text('email'),
  bankName: text('bank_name'),
  bankAccount: text('bank_account'),
  timezone: varchar('timezone', { length: 64 }).notNull().default('Europe/Skopje'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
