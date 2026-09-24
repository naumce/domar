export type QuorumBasis = 'share' | 'count';
export type VoteChoice = 'for' | 'against' | 'abstain';
export type DecisionResult = 'passed' | 'rejected' | 'no_quorum';

/** One owner of the building and the weight their ownership share is worth, in basis points. */
export interface AssemblyOwner {
  contactId: string;
  /** `Σ round(ownership_share × 10000)` over the owner's units. Always the *share* weight, even
   *  when the assembly runs a `count` quorum — `ownerWeight` decides what the basis makes of it. */
  weight: number;
}

export interface AssemblyAttendee {
  contactId: string;
  /** In person or by proxy; a proxy holder's name is bookkeeping, not arithmetic. */
  present: boolean;
}

export interface AssemblyVote {
  contactId: string;
  choice: VoteChoice;
}

export interface DecisionTally {
  for: number;
  against: number;
  abstain: number;
  /** Weight of the owners who were present; what the quorum is measured with. */
  present: number;
  /** Weight of every owner of the building. */
  basisTotal: number;
  quorumReached: boolean;
  result: DecisionResult;
}

/** An ownership share (0–1) as whole basis points, so every later sum is exact integer arithmetic. */
export function shareWeightBp(share: number): number {
  return Math.round(share * 10000);
}

/** What one owner weighs under a given basis: their share, or one owner-one-vote (plan addendum 2). */
export function ownerWeight(basis: QuorumBasis, owner: AssemblyOwner): number {
  return basis === 'count' ? 1 : owner.weight;
}

/**
 * Art. 37, one decision. Pure: the same owners, attendance and votes always give the same tally.
 *
 * - The quorum is reached when the present weight is **strictly more** than half the basis, so an
 *   assembly attended by exactly half the building decides nothing (plan addendum 4).
 * - A decision passes when `for > against` **and** the quorum was reached; a tie is a rejection,
 *   because a proposal that did not win a majority did not pass.
 * - Abstentions are tallied and never compared: they are a recorded refusal to decide.
 * - Only owners marked present are counted, at most one vote each, and a vote from somebody who
 *   owns nothing in this building is ignored — so `for + against + abstain ≤ present` always holds.
 */
export function tallyDecision(basis: QuorumBasis, owners: AssemblyOwner[], attendance: AssemblyAttendee[], votes: AssemblyVote[]): DecisionTally {
  const weightOf = new Map(owners.map((o) => [o.contactId, ownerWeight(basis, o)]));
  let basisTotal = 0;
  for (const w of weightOf.values()) basisTotal += w;

  const presentIds = new Set(attendance.filter((a) => a.present && weightOf.has(a.contactId)).map((a) => a.contactId));
  let present = 0;
  for (const id of presentIds) present += weightOf.get(id)!;

  const counted = new Set<string>();
  const cast = { for: 0, against: 0, abstain: 0 };
  for (const v of votes) {
    if (!presentIds.has(v.contactId) || counted.has(v.contactId)) continue;
    counted.add(v.contactId);
    cast[v.choice] += weightOf.get(v.contactId)!;
  }

  const quorumReached = present * 2 > basisTotal;
  const result: DecisionResult = !quorumReached ? 'no_quorum' : cast.for > cast.against ? 'passed' : 'rejected';
  return { ...cast, present, basisTotal, quorumReached, result };
}
