import { type AnyPgColumn, index, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { contacts } from './contact.js';
import { tenants } from './tenant.js';

export const shareBasis = pgEnum('share_basis', ['area', 'equal', 'custom']);
export const unitKind = pgEnum('unit_kind', ['apartment', 'commercial', 'parking', 'storage', 'other']);

export const buildings = pgTable(
  'buildings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    address: text('address').notNull().default(''),
    city: text('city').notNull().default(''),
    postalCode: text('postal_code').notNull().default(''),
    countryCode: text('country_code').notNull(),
    representativeContactId: uuid('representative_contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    regularFundAccount: text('regular_fund_account'),
    reserveFundAccount: text('reserve_fund_account'),
    shareBasis: shareBasis('share_basis').notNull().default('area'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('buildings_tenant_idx').on(t.tenantId, t.name)],
);

export const units = pgTable(
  'units',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    buildingId: uuid('building_id').notNull().references(() => buildings.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    floor: text('floor'),
    kind: unitKind('kind').notNull(),
    areaM2: numeric('area_m2', { precision: 10, scale: 2 }),
    ownershipShare: numeric('ownership_share', { precision: 9, scale: 6 }),
    ownerContactId: uuid('owner_contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    attachedToUnitId: uuid('attached_to_unit_id').references((): AnyPgColumn => units.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('units_tenant_building_idx').on(t.tenantId, t.buildingId),
    uniqueIndex('units_building_label_idx').on(t.buildingId, t.label),
  ],
);
