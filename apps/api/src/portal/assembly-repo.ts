import { type Db, schema } from '@domar/db';
import type { VoteChoice } from '@domar/domain';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { writeAudit } from '../audit.js';
import { conflict, notFound } from '../errors.js';
import { upsertVote } from '../resources/assemblies/votes.js';
import type { TenantContext } from '../tenant-context.js';
import type { PortalContext } from './context.js';
import { assertOwnsUnitIn, resolveLink } from './repo.js';

const A = schema.assemblies; const AD = schema.assemblyDecisions; const AV = schema.assemblyVotes;
const B = schema.buildings; const U = schema.units;

/** A draft is not an invitation and a cancelled assembly is not happening: neither is an owner's business. */
const VISIBLE_STATUSES = ['invited', 'held'] as const;
type VisibleStatus = (typeof VISIBLE_STATUSES)[number];

async function ownedBuildingIds(db: Db, ctx: TenantContext, contactId: string): Promise<string[]> {
  const rows = await db.selectDistinct({ buildingId: U.buildingId }).from(U)
    .where(and(eq(U.tenantId, ctx.tenantId), eq(U.ownerContactId, contactId)));
  return rows.map((r) => r.buildingId);
}

export async function portalAssemblies(db: Db, portal: PortalContext, contactIdParam: string) {
  const { ctx, contactId } = resolveLink(portal, contactIdParam);
  const buildingIds = await ownedBuildingIds(db, ctx, contactId);
  if (buildingIds.length === 0) return { rows: [] };
  const rows = await db.select({ a: A, buildingName: B.name }).from(A)
    .innerJoin(B, and(eq(B.id, A.buildingId), eq(B.tenantId, A.tenantId)))
    .where(and(eq(A.tenantId, ctx.tenantId), inArray(A.buildingId, buildingIds), inArray(A.status, [...VISIBLE_STATUSES])))
    .orderBy(desc(A.scheduledAt), desc(A.createdAt));
  return {
    rows: rows.map((r) => ({
      id: r.a.id, buildingId: r.a.buildingId, buildingName: r.buildingName, scheduledAt: r.a.scheduledAt,
      location: r.a.location, status: r.a.status as VisibleStatus, heldAt: r.a.heldAt,
      minutesDocumentId: r.a.minutesDocumentId, agendaCount: r.a.agenda.length,
    })),
  };
}

/**
 * The three checks every portal read makes, applied to one assembly before anything is returned.
 * `lock` is for the ballot: it takes the very row `claimAssembly` locks when the assembly is held,
 * so a vote arriving during a hold waits for it and is then refused, rather than being stored after
 * the hold has already counted the ballots.
 */
async function visibleAssembly(db: Db, ctx: TenantContext, contactId: string, id: string, lock = false) {
  const query = db.select().from(A).where(and(eq(A.tenantId, ctx.tenantId), eq(A.id, id))).limit(1);
  const [row] = await (lock ? query.for('update') : query);
  if (!row || !VISIBLE_STATUSES.includes(row.status as VisibleStatus)) throw notFound('Assembly');
  await assertOwnsUnitIn(db, ctx, contactId, row.buildingId);
  return row;
}

export async function portalAssembly(db: Db, portal: PortalContext, contactIdParam: string, id: string) {
  const { ctx, contactId } = resolveLink(portal, contactIdParam);
  const row = await visibleAssembly(db, ctx, contactId, id);
  const [[building], decisions, mine] = await Promise.all([
    db.select({ name: B.name }).from(B).where(and(eq(B.tenantId, ctx.tenantId), eq(B.id, row.buildingId))).limit(1),
    db.select().from(AD).where(and(eq(AD.tenantId, ctx.tenantId), eq(AD.assemblyId, id))).orderBy(asc(AD.sortOrder), asc(AD.createdAt), asc(AD.id)),
    db.select().from(AV).where(and(eq(AV.tenantId, ctx.tenantId), eq(AV.assemblyId, id), eq(AV.contactId, contactId))),
  ]);
  const myChoice = new Map(mine.map((v) => [v.decisionId, v.choice]));
  const held = row.status === 'held';
  return {
    id: row.id, buildingId: row.buildingId, buildingName: building?.name ?? '',
    scheduledAt: row.scheduledAt, location: row.location, status: row.status as VisibleStatus,
    heldAt: row.heldAt, minutesDocumentId: row.minutesDocumentId, agenda: row.agenda,
    votingOpen: row.status === 'invited',
    decisions: decisions.map((d) => ({
      id: d.id, title: d.title, text: d.text, myChoice: myChoice.get(d.id) ?? null,
      // Nothing about the running tally leaks while the ballot is open (plan addendum 17).
      forWeight: held ? d.forWeight : null, againstWeight: held ? d.againstWeight : null,
      abstainWeight: held ? d.abstainWeight : null, presentWeight: held ? d.presentWeight : null,
      basisTotal: held ? d.basisTotal : null, quorumReached: held ? d.quorumReached : null,
      result: held ? d.result : null,
    })),
  };
}

/** The portal's only write (plan addendum 17): link, unit, window, then an upsert on the vote. */
export async function portalCastVote(db: Db, portal: PortalContext, contactIdParam: string, id: string, decisionId: string, choice: VoteChoice) {
  const { ctx, contactId } = resolveLink(portal, contactIdParam);
  await db.transaction(async (tx) => {
    const row = await visibleAssembly(tx, ctx, contactId, id, true);
    if (row.status !== 'invited') throw conflict('voting_closed', 'Voting on this assembly is closed');
    const [decision] = await tx.select({ id: AD.id }).from(AD)
      .where(and(eq(AD.tenantId, ctx.tenantId), eq(AD.assemblyId, id), eq(AD.id, decisionId))).limit(1);
    if (!decision) throw notFound('Decision');
    await upsertVote(tx, ctx, { assemblyId: id, decisionId, contactId, choice, via: 'portal' });
    // `ctx` here is the portal's read-only context: user id null, role `readonly` (spec §19.6).
    await writeAudit(tx, ctx, {
      action: 'assembly_vote.cast', entityType: 'assembly_decision', entityId: decisionId,
      after: { contactId, choice, via: 'portal' },
    });
  });
  return portalAssembly(db, portal, contactIdParam, id);
}

export async function portalAssemblyInvitation(db: Db, portal: PortalContext, contactIdParam: string, id: string) {
  const { ctx, contactId } = resolveLink(portal, contactIdParam);
  const row = await visibleAssembly(db, ctx, contactId, id);
  if (!row.invitationHtml) throw notFound('Assembly');
  return { html: row.invitationHtml, id: row.id };
}
