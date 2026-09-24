import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { buildings } from './building.js';
import { documents } from './compliance.js';
import { contacts } from './contact.js';
import { emailLog } from './reminders.js';
import { tenants } from './tenant.js';

/** Spec §6. `held` is terminal; `cancelled` is reachable from `draft` and `invited` only. */
export const assemblyStatus = pgEnum('assembly_status', ['draft', 'invited', 'held', 'cancelled']);
/** `share` = the owner's summed ownership share; `count` = one vote per owner (plan addendum 2). */
export const quorumBasis = pgEnum('quorum_basis', ['share', 'count']);
/** Deliberately not `reminder_channel`: an invitation is not a reminder (plan addendum 19). */
export const assemblyChannel = pgEnum('assembly_channel', ['email', 'letter']);
/** `cancelled`: the assembly was called off before this invitation was ever delivered. */
export const assemblyInvitationStatus = pgEnum('assembly_invitation_status', ['pending', 'sent', 'failed', 'printed', 'cancelled']);
export const voteChoice = pgEnum('vote_choice', ['for', 'against', 'abstain']);
export const voteVia = pgEnum('vote_via', ['portal', 'paper']);
/** `pending` until the assembly is held; the other three are what `tallyDecision` returns. */
export const decisionResult = pgEnum('decision_result', ['pending', 'passed', 'rejected', 'no_quorum']);

/** One agenda point. `id` is a server-generated uuid so the web can key a list on it. */
export interface AgendaItem { id: string; title: string; text: string }

const tenantRef = () => uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' });
const ts = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Art. 37: one assembly of the owners of one building. */
export const assemblies = pgTable('assemblies', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  buildingId: uuid('building_id').notNull().references(() => buildings.id, { onDelete: 'cascade' }),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
  location: text('location').notNull().default(''),
  agenda: jsonb('agenda').$type<AgendaItem[]>().notNull().default(sql`'[]'::jsonb`),
  status: assemblyStatus('status').notNull().default('draft'),
  quorumBasis: quorumBasis('quorum_basis').notNull().default('share'),
  invitedAt: timestamp('invited_at', { withTimezone: true }),
  heldAt: timestamp('held_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancelReason: text('cancel_reason'),
  /** Art. 37 needs 15 days; an invitation sent later is stamped here and audited (plan addendum 8). */
  lateInvitation: boolean('late_invitation').notNull().default(false),
  lateReason: text('late_reason'),
  /** Rendered once at invite time and re-rendered to PDF on demand, like `reminders.document_html`. */
  invitationHtml: text('invitation_html'),
  minutesHtml: text('minutes_html'),
  minutesDocumentId: uuid('minutes_document_id').references(() => documents.id, { onDelete: 'set null' }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  ...ts(),
}, (t) => [
  index('assemblies_tenant_building_idx').on(t.tenantId, t.buildingId, t.scheduledAt),
  index('assemblies_tenant_status_idx').on(t.tenantId, t.status, t.scheduledAt),
]);

/** One row per owner contact at invite time; the set is frozen when the invitations go out. */
export const assemblyInvitations = pgTable('assembly_invitations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  assemblyId: uuid('assembly_id').notNull().references(() => assemblies.id, { onDelete: 'cascade' }),
  // restrict, like reminders: a contact with delivery evidence against them cannot be deleted.
  contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'restrict' }),
  channel: assemblyChannel('channel').notNull(),
  status: assemblyInvitationStatus('status').notNull().default('pending'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  error: text('error'),
  emailLogId: uuid('email_log_id').references(() => emailLog.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('assembly_invitations_tenant_assembly_idx').on(t.tenantId, t.assemblyId, t.createdAt),
  uniqueIndex('assembly_invitations_assembly_contact_idx').on(t.assemblyId, t.contactId),
]);

/** Written once, when the assembly is held. `weight_bp` freezes what the owner weighed that day. */
export const assemblyAttendance = pgTable('assembly_attendance', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  assemblyId: uuid('assembly_id').notNull().references(() => assemblies.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'restrict' }),
  present: boolean('present').notNull().default(false),
  /** Non-null when the owner was represented; the proxy holder's name goes in the minutes. */
  proxyName: text('proxy_name'),
  /** Basis points under a `share` quorum, `1` under a `count` quorum. Not money: `integer`. */
  weightBp: integer('weight_bp').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('assembly_attendance_tenant_assembly_idx').on(t.tenantId, t.assemblyId),
  uniqueIndex('assembly_attendance_assembly_contact_idx').on(t.assemblyId, t.contactId),
]);

/** One proposal put to the vote. The five weights are `pending`/zero until the assembly is held. */
export const assemblyDecisions = pgTable('assembly_decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  assemblyId: uuid('assembly_id').notNull().references(() => assemblies.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  text: text('text'),
  sortOrder: integer('sort_order').notNull().default(0),
  forWeight: integer('for_weight').notNull().default(0),
  againstWeight: integer('against_weight').notNull().default(0),
  abstainWeight: integer('abstain_weight').notNull().default(0),
  presentWeight: integer('present_weight').notNull().default(0),
  basisTotal: integer('basis_total').notNull().default(0),
  quorumReached: boolean('quorum_reached').notNull().default(false),
  result: decisionResult('result').notNull().default('pending'),
  ...ts(),
}, (t) => [index('assembly_decisions_tenant_assembly_idx').on(t.tenantId, t.assemblyId, t.sortOrder)]);

/** One owner's vote on one decision. The unique index is what makes a change of mind an upsert. */
export const assemblyVotes = pgTable('assembly_votes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: tenantRef(),
  /** Denormalised from the decision so every vote query can be scoped without a join. */
  assemblyId: uuid('assembly_id').notNull().references(() => assemblies.id, { onDelete: 'cascade' }),
  decisionId: uuid('decision_id').notNull().references(() => assemblyDecisions.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'restrict' }),
  choice: voteChoice('choice').notNull(),
  via: voteVia('via').notNull(),
  castAt: timestamp('cast_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('assembly_votes_tenant_assembly_idx').on(t.tenantId, t.assemblyId, t.contactId),
  uniqueIndex('assembly_votes_decision_contact_idx').on(t.decisionId, t.contactId),
]);
