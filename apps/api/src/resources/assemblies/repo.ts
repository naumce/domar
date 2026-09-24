import { randomUUID } from 'node:crypto';
import { type Db, schema } from '@domar/db';
import { type AssemblyOwner, type CountryCode, getCountryPack, shareWeightBp } from '@domar/domain';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { badRequest, conflict, notFound } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { getBuilding } from '../buildings/repo.js';
import type { AgendaItemIn, AssemblyCreate, AssemblyPatch, DecisionCreate, DecisionPatch } from './schema.js';

const A = schema.assemblies; const AD = schema.assemblyDecisions; const AI = schema.assemblyInvitations;
const AT = schema.assemblyAttendance; const AV = schema.assemblyVotes;
const C = schema.contacts; const U = schema.units; const T = schema.tenants;

export type AssemblyRow = typeof A.$inferSelect;
export type DecisionRow = typeof AD.$inferSelect;
export type AssemblyStatus = (typeof schema.assemblyStatus.enumValues)[number];
export type QuorumBasisValue = (typeof schema.quorumBasis.enumValues)[number];

/** The rendered documents and the tenant id never go on the wire; everything else does. */
export const publicAssembly = ({ tenantId: _tenantId, invitationHtml: _invitationHtml, minutesHtml: _minutesHtml, createdBy: _createdBy, ...rest }: AssemblyRow) => rest;

/** The tenant row and its country pack. `tenants.country_code` is a plain varchar, so an unsupported value arrives here as undefined. */
export async function tenantPack(db: Db, ctx: TenantContext) {
  const tenant = (await db.query.tenants.findFirst({ where: eq(T.id, ctx.tenantId) }))!;
  const pack = getCountryPack(tenant.countryCode as CountryCode);
  if (!pack) throw new Error(`unknown country pack: ${tenant.countryCode}`);
  return { tenant, pack };
}

/** Every stored agenda item carries an id and a string `text`, whatever the client sent. */
export function normaliseAgenda(items: AgendaItemIn[] | undefined) {
  return (items ?? []).map((x) => ({ id: x.id ?? randomUUID(), title: x.title, text: x.text ?? '' }));
}

export async function getAssemblyRow(db: Db, ctx: TenantContext, id: string): Promise<AssemblyRow> {
  const row = await db.query.assemblies.findFirst({ where: and(eq(A.tenantId, ctx.tenantId), eq(A.id, id)) });
  if (!row) throw notFound('Assembly');
  return row;
}

/**
 * Claim-first transition, exactly like `claimPeriod`: the status check and the lock are one
 * statement, so two clicks cannot both win. A row of another tenant is a 404, never a 409.
 */
export async function claimAssembly(tx: Db, ctx: TenantContext, id: string, allowed: AssemblyStatus[]): Promise<AssemblyRow> {
  const [row] = await tx.update(A).set({ updatedAt: new Date() })
    .where(and(eq(A.tenantId, ctx.tenantId), eq(A.id, id), inArray(A.status, allowed))).returning();
  if (!row) {
    await getAssemblyRow(tx, ctx, id); // 404 across tenants
    throw conflict('assembly_locked', `Only an assembly with status ${allowed.join(' or ')} can be changed this way`);
  }
  return row;
}

/**
 * The owners of the building and what each of them weighs, in basis points of the whole building.
 * A `share` quorum refuses to run on a building whose owned units have no share (plan addendum 3):
 * treating a missing share as zero would disenfranchise that owner *and* lower the quorum bar.
 */
export async function assemblyOwners(db: Db, ctx: TenantContext, buildingId: string, basis: QuorumBasisValue): Promise<AssemblyOwner[]> {
  const rows = await db.select({ ownerContactId: U.ownerContactId, ownershipShare: U.ownershipShare, label: U.label })
    .from(U).where(and(eq(U.tenantId, ctx.tenantId), eq(U.buildingId, buildingId)));
  const owned = rows.filter((r) => r.ownerContactId !== null);
  if (owned.length === 0) throw badRequest('no_owners', 'No unit in this building has an owner');
  if (basis === 'share') {
    const missing = owned.filter((r) => r.ownershipShare === null).map((r) => r.label).sort();
    if (missing.length > 0) {
      throw badRequest('missing_ownership_shares', `A 'share' quorum needs ownershipShare on every owned unit; these have none: ${missing.join(', ')}`, { units: missing });
    }
  }
  const byContact = new Map<string, number>();
  for (const r of owned) {
    const weight = r.ownershipShare === null ? 0 : shareWeightBp(Number(r.ownershipShare));
    byContact.set(r.ownerContactId!, (byContact.get(r.ownerContactId!) ?? 0) + weight);
  }
  return [...byContact].map(([contactId, weight]) => ({ contactId, weight })).sort((x, y) => x.contactId.localeCompare(y.contactId));
}

const fullName = (first: string, last: string) => `${first} ${last}`.trim();
const toDecisionOut = (d: DecisionRow) => ({
  id: d.id, title: d.title, text: d.text, sortOrder: d.sortOrder,
  forWeight: d.forWeight, againstWeight: d.againstWeight, abstainWeight: d.abstainWeight,
  presentWeight: d.presentWeight, basisTotal: d.basisTotal, quorumReached: d.quorumReached, result: d.result,
});

/** Decisions of one assembly in their fixed order; used by the invitation, the hold and the detail. */
export async function listDecisionRows(db: Db, ctx: TenantContext, assemblyId: string): Promise<DecisionRow[]> {
  return db.select().from(AD).where(and(eq(AD.tenantId, ctx.tenantId), eq(AD.assemblyId, assemblyId)))
    .orderBy(asc(AD.sortOrder), asc(AD.createdAt), asc(AD.id));
}

export async function getAssembly(db: Db, ctx: TenantContext, id: string) {
  const row = await getAssemblyRow(db, ctx, id);
  const [decisions, invitations, attendance, votes] = await Promise.all([
    listDecisionRows(db, ctx, id),
    db.select({ i: AI, firstName: C.firstName, lastName: C.lastName, email: C.email }).from(AI)
      .innerJoin(C, and(eq(C.id, AI.contactId), eq(C.tenantId, AI.tenantId)))
      .where(and(eq(AI.tenantId, ctx.tenantId), eq(AI.assemblyId, id))).orderBy(asc(C.lastName), asc(C.firstName)),
    db.select({ a: AT, firstName: C.firstName, lastName: C.lastName }).from(AT)
      .innerJoin(C, and(eq(C.id, AT.contactId), eq(C.tenantId, AT.tenantId)))
      .where(and(eq(AT.tenantId, ctx.tenantId), eq(AT.assemblyId, id))).orderBy(asc(C.lastName), asc(C.firstName)),
    db.select().from(AV).where(and(eq(AV.tenantId, ctx.tenantId), eq(AV.assemblyId, id))).orderBy(asc(AV.castAt), asc(AV.id)),
  ]);
  return {
    ...publicAssembly(row),
    decisionCount: decisions.length,
    invitationCount: invitations.length,
    decisions: decisions.map(toDecisionOut),
    invitations: invitations.map((r) => ({
      id: r.i.id, contactId: r.i.contactId, contactName: fullName(r.firstName, r.lastName), email: r.email,
      channel: r.i.channel, status: r.i.status, sentAt: r.i.sentAt, error: r.i.error,
    })),
    attendance: attendance.map((r) => ({
      contactId: r.a.contactId, contactName: fullName(r.firstName, r.lastName),
      present: r.a.present, proxyName: r.a.proxyName, weightBp: r.a.weightBp,
    })),
    votes: votes.map((v) => ({ decisionId: v.decisionId, contactId: v.contactId, choice: v.choice, via: v.via, castAt: v.castAt })),
  };
}

export async function listAssemblies(db: Db, ctx: TenantContext, buildingId: string) {
  await getBuilding(db, ctx, buildingId); // 404 across tenants
  // "assemblies"."id" is hard-coded for the same reason as in resources/buildings/repo.ts: drizzle
  // renders single-table select columns unqualified inside raw sql, so a bare `id` would bind wrong.
  const rows = await db.select({
    a: A,
    decisionCount: sql<number>`(select count(*) from ${AD} d where d.assembly_id = "assemblies"."id")`.mapWith(Number),
    invitationCount: sql<number>`(select count(*) from ${AI} i where i.assembly_id = "assemblies"."id")`.mapWith(Number),
  }).from(A).where(and(eq(A.tenantId, ctx.tenantId), eq(A.buildingId, buildingId)))
    .orderBy(desc(A.scheduledAt), desc(A.createdAt));
  return { rows: rows.map((r) => ({ ...publicAssembly(r.a), decisionCount: r.decisionCount, invitationCount: r.invitationCount })) };
}

export async function createAssembly(db: Db, ctx: TenantContext, buildingId: string, input: AssemblyCreate) {
  return db.transaction(async (tx) => {
    await getBuilding(tx, ctx, buildingId); // 404 across tenants
    const [row] = await tx.insert(A).values({
      tenantId: ctx.tenantId, buildingId, scheduledAt: new Date(input.scheduledAt),
      location: input.location ?? '', agenda: normaliseAgenda(input.agenda),
      ...(input.quorumBasis ? { quorumBasis: input.quorumBasis } : {}),
      createdBy: ctx.userId,
    }).returning();
    const decisions = input.decisions ?? [];
    if (decisions.length > 0) {
      await tx.insert(AD).values(decisions.map((d, i) => ({
        tenantId: ctx.tenantId, assemblyId: row!.id, title: d.title, text: d.text ?? null, sortOrder: i,
      })));
    }
    await writeAudit(tx, ctx, {
      action: 'assembly.create', entityType: 'assembly', entityId: row!.id,
      after: { ...publicAssembly(row!), decisions: decisions.map((d) => d.title) },
    });
    return getAssembly(tx, ctx, row!.id);
  });
}

export async function updateAssembly(db: Db, ctx: TenantContext, id: string, input: AssemblyPatch) {
  return db.transaction(async (tx) => {
    const before = await claimAssembly(tx, ctx, id, ['draft', 'invited']);
    // The basis the invitations announced is the basis the assembly decides by (plan addendum 2).
    if (input.quorumBasis && input.quorumBasis !== before.quorumBasis && before.status !== 'draft') {
      throw conflict('quorum_basis_locked', 'The quorum basis is frozen once the invitations have gone out');
    }
    const set: Partial<typeof A.$inferInsert> = { updatedAt: new Date() };
    if (input.scheduledAt !== undefined) set.scheduledAt = new Date(input.scheduledAt);
    if (input.location !== undefined) set.location = input.location;
    if (input.quorumBasis !== undefined) set.quorumBasis = input.quorumBasis;
    if (input.agenda !== undefined) set.agenda = normaliseAgenda(input.agenda);
    const [row] = await tx.update(A).set(set).where(and(eq(A.tenantId, ctx.tenantId), eq(A.id, id))).returning();
    await writeAudit(tx, ctx, { action: 'assembly.update', entityType: 'assembly', entityId: id, before: publicAssembly(before), after: publicAssembly(row!) });
    return getAssembly(tx, ctx, id);
  });
}

/** Only a draft disappears: an invited assembly leaves evidence behind and is cancelled instead. */
export async function deleteAssembly(db: Db, ctx: TenantContext, id: string) {
  return db.transaction(async (tx) => {
    const before = await claimAssembly(tx, ctx, id, ['draft']);
    await tx.delete(A).where(and(eq(A.tenantId, ctx.tenantId), eq(A.id, id)));
    await writeAudit(tx, ctx, { action: 'assembly.delete', entityType: 'assembly', entityId: id, before: publicAssembly(before) });
  });
}

export async function createDecision(db: Db, ctx: TenantContext, id: string, input: DecisionCreate) {
  return db.transaction(async (tx) => {
    await claimAssembly(tx, ctx, id, ['draft', 'invited']);
    const [existing] = await tx.select({ n: count() }).from(AD).where(and(eq(AD.tenantId, ctx.tenantId), eq(AD.assemblyId, id)));
    const [row] = await tx.insert(AD).values({
      tenantId: ctx.tenantId, assemblyId: id, title: input.title, text: input.text ?? null,
      sortOrder: input.sortOrder ?? Number(existing?.n ?? 0),
    }).returning();
    await writeAudit(tx, ctx, { action: 'assembly_decision.create', entityType: 'assembly_decision', entityId: row!.id, after: row });
    return getAssembly(tx, ctx, id);
  });
}

export async function updateDecision(db: Db, ctx: TenantContext, id: string, decisionId: string, input: DecisionPatch) {
  return db.transaction(async (tx) => {
    await claimAssembly(tx, ctx, id, ['draft', 'invited']);
    const before = await tx.query.assemblyDecisions.findFirst({ where: and(eq(AD.tenantId, ctx.tenantId), eq(AD.assemblyId, id), eq(AD.id, decisionId)) });
    if (!before) throw notFound('Decision');
    const set: Partial<typeof AD.$inferInsert> = { updatedAt: new Date() };
    if (input.title !== undefined) set.title = input.title;
    if (input.text !== undefined) set.text = input.text;
    if (input.sortOrder !== undefined) set.sortOrder = input.sortOrder;
    const [row] = await tx.update(AD).set(set).where(and(eq(AD.tenantId, ctx.tenantId), eq(AD.id, decisionId))).returning();
    await writeAudit(tx, ctx, { action: 'assembly_decision.update', entityType: 'assembly_decision', entityId: decisionId, before, after: row });
    return getAssembly(tx, ctx, id);
  });
}

export async function deleteDecision(db: Db, ctx: TenantContext, id: string, decisionId: string) {
  return db.transaction(async (tx) => {
    await claimAssembly(tx, ctx, id, ['draft', 'invited']);
    const before = await tx.query.assemblyDecisions.findFirst({ where: and(eq(AD.tenantId, ctx.tenantId), eq(AD.assemblyId, id), eq(AD.id, decisionId)) });
    if (!before) throw notFound('Decision');
    // The votes cast on it go with it (`assembly_votes.decision_id` cascades).
    await tx.delete(AD).where(and(eq(AD.tenantId, ctx.tenantId), eq(AD.id, decisionId)));
    await writeAudit(tx, ctx, { action: 'assembly_decision.delete', entityType: 'assembly_decision', entityId: decisionId, before });
  });
}
