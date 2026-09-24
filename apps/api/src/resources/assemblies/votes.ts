import { type Db, schema } from '@domar/db';
import { ownerWeight, type VoteChoice } from '@domar/domain';
import { and, eq, inArray } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { badRequest, conflict, notFound } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { assemblyOwners, getAssembly, getAssemblyRow } from './repo.js';

const AD = schema.assemblyDecisions; const AV = schema.assemblyVotes; const C = schema.contacts;

export interface NewVote {
  assemblyId: string;
  decisionId: string;
  contactId: string;
  choice: VoteChoice;
  via: 'portal' | 'paper';
}

/**
 * One vote per contact per decision, changeable while the window is open: the unique index
 * `(decision_id, contact_id)` turns a change of mind into an UPDATE instead of a second row, and
 * two simultaneous clicks into one row rather than a unique violation.
 */
export async function upsertVote(tx: Db, ctx: TenantContext, v: NewVote): Promise<void> {
  await tx.insert(AV).values({ tenantId: ctx.tenantId, ...v })
    .onConflictDoUpdate({ target: [AV.decisionId, AV.contactId], set: { choice: v.choice, via: v.via, castAt: new Date() } });
}

/** The manager typing what somebody wrote on paper. Same window, same one-vote rule as the portal. */
export async function castPaperVote(db: Db, ctx: TenantContext, id: string, decisionId: string, input: { contactId: string; choice: VoteChoice }) {
  return db.transaction(async (tx) => {
    const assembly = await getAssemblyRow(tx, ctx, id); // 404 across tenants
    if (assembly.status !== 'invited') throw conflict('voting_closed', 'Voting is open only while the assembly is called');
    const [decision] = await tx.select({ id: AD.id }).from(AD)
      .where(and(eq(AD.tenantId, ctx.tenantId), eq(AD.assemblyId, id), eq(AD.id, decisionId))).limit(1);
    if (!decision) throw notFound('Decision');
    const owners = await assemblyOwners(tx, ctx, assembly.buildingId, assembly.quorumBasis);
    if (!owners.some((o) => o.contactId === input.contactId)) {
      throw badRequest('invalid_reference', 'That contact owns no unit in this building');
    }
    await upsertVote(tx, ctx, { assemblyId: id, decisionId, contactId: input.contactId, choice: input.choice, via: 'paper' });
    await writeAudit(tx, ctx, {
      action: 'assembly_vote.cast', entityType: 'assembly_decision', entityId: decisionId,
      after: { contactId: input.contactId, choice: input.choice, via: 'paper' },
    });
    return getAssembly(tx, ctx, id);
  });
}

/** What the attendance sheet is drawn from: who owns something here and what they weigh today. */
export async function listAssemblyOwners(db: Db, ctx: TenantContext, id: string) {
  const assembly = await getAssemblyRow(db, ctx, id); // 404 across tenants
  const owners = await assemblyOwners(db, ctx, assembly.buildingId, assembly.quorumBasis);
  const contacts = await db.select({ id: C.id, firstName: C.firstName, lastName: C.lastName, email: C.email }).from(C)
    .where(and(eq(C.tenantId, ctx.tenantId), inArray(C.id, owners.map((o) => o.contactId))));
  const byId = new Map(contacts.map((c) => [c.id, c]));
  const rows = owners.map((o) => {
    const c = byId.get(o.contactId);
    return {
      contactId: o.contactId,
      contactName: `${c?.firstName ?? ''} ${c?.lastName ?? ''}`.trim(),
      email: c?.email ?? null,
      weightBp: ownerWeight(assembly.quorumBasis, o),
    };
  }).sort((x, y) => x.contactName.localeCompare(y.contactName, 'mk'));
  return { rows, basisTotal: rows.reduce((s, r) => s + r.weightBp, 0), quorumBasis: assembly.quorumBasis };
}
