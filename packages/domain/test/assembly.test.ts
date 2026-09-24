import { describe, expect, it } from 'vitest';
import { ownerWeight, shareWeightBp, tallyDecision, type AssemblyOwner } from '../src/assembly/tally.js';
import { mkPack } from '../src/country/mk.js';

/** Три сопственици: 0.5 / 0.3 / 0.2 → 5000 / 3000 / 2000 basis points, basisTotal 10000. */
const A = 'c-anastasova';
const B = 'c-bogdanov';
const C = 'c-cvetkov';
const owners: AssemblyOwner[] = [
  { contactId: A, weight: 5000 },
  { contactId: B, weight: 3000 },
  { contactId: C, weight: 2000 },
];
const present = (...ids: string[]) => owners.map((o) => ({ contactId: o.contactId, present: ids.includes(o.contactId) }));

describe('shareWeightBp', () => {
  it('turns an ownership share into whole basis points', () => {
    expect(shareWeightBp(0.5)).toBe(5000);
    expect(shareWeightBp(0.3)).toBe(3000);
    expect(shareWeightBp(0.012345)).toBe(123);
    expect(shareWeightBp(0.0125)).toBe(125);
    expect(shareWeightBp(1)).toBe(10000);
    expect(shareWeightBp(0)).toBe(0);
  });
});

describe('ownerWeight', () => {
  it('is the share under a share quorum and one under a count quorum', () => {
    expect(ownerWeight('share', owners[0]!)).toBe(5000);
    expect(ownerWeight('count', owners[0]!)).toBe(1);
  });
});

describe('tallyDecision — quorum', () => {
  it('needs strictly more than half of the basis', () => {
    // 5000 of 10000 is exactly half: not a quorum.
    const half = tallyDecision('share', owners, present(A), []);
    expect(half.basisTotal).toBe(10000);
    expect(half.present).toBe(5000);
    expect(half.quorumReached).toBe(false);
    expect(half.result).toBe('no_quorum');
    // 8000 of 10000 is more than half.
    const most = tallyDecision('share', owners, present(A, B), []);
    expect(most.present).toBe(8000);
    expect(most.quorumReached).toBe(true);
  });

  it('counts owners, not shares, under a count quorum', () => {
    const one = tallyDecision('count', owners, present(A), []);
    expect(one.basisTotal).toBe(3);
    expect(one.present).toBe(1);
    expect(one.quorumReached).toBe(false);
    const two = tallyDecision('count', owners, present(A, B), []);
    expect(two.present).toBe(2);
    expect(two.quorumReached).toBe(true);
  });

  it('ignores an attendance row for somebody who is not an owner', () => {
    const t = tallyDecision('share', owners, [...present(A, B), { contactId: 'c-stranger', present: true }], []);
    expect(t.present).toBe(8000);
    expect(t.basisTotal).toBe(10000);
  });
});

describe('tallyDecision — the vote', () => {
  it('passes when the for-weight beats the against-weight', () => {
    const t = tallyDecision('share', owners, present(A, B), [
      { contactId: A, choice: 'for' }, { contactId: B, choice: 'against' },
    ]);
    expect(t).toEqual({ for: 5000, against: 3000, abstain: 0, present: 8000, basisTotal: 10000, quorumReached: true, result: 'passed' });
  });

  it('rejects the same two votes under a count quorum, where the shares do not matter', () => {
    const t = tallyDecision('count', owners, present(A, B), [
      { contactId: A, choice: 'for' }, { contactId: B, choice: 'against' },
    ]);
    expect(t).toEqual({ for: 1, against: 1, abstain: 0, present: 2, basisTotal: 3, quorumReached: true, result: 'rejected' });
  });

  it('counts abstentions separately and never lets them decide', () => {
    const t = tallyDecision('share', owners, present(A, B), [
      { contactId: A, choice: 'abstain' }, { contactId: B, choice: 'for' },
    ]);
    expect(t.abstain).toBe(5000);
    expect(t.for).toBe(3000);
    expect(t.against).toBe(0);
    expect(t.result).toBe('passed');
  });

  it('rejects a tie', () => {
    const tied: AssemblyOwner[] = [{ contactId: A, weight: 5000 }, { contactId: B, weight: 5000 }];
    const t = tallyDecision('share', tied, [{ contactId: A, present: true }, { contactId: B, present: true }], [
      { contactId: A, choice: 'for' }, { contactId: B, choice: 'against' },
    ]);
    expect(t.quorumReached).toBe(true);
    expect(t.result).toBe('rejected');
  });

  it('still tallies the votes when the quorum failed, and reports no_quorum', () => {
    const t = tallyDecision('share', owners, present(A), [{ contactId: A, choice: 'for' }]);
    expect(t.for).toBe(5000);
    expect(t.result).toBe('no_quorum');
  });

  it('drops a vote from an owner who is not marked present', () => {
    const t = tallyDecision('share', owners, present(A, B), [
      { contactId: A, choice: 'for' }, { contactId: C, choice: 'against' },
    ]);
    expect(t.for).toBe(5000);
    expect(t.against).toBe(0);
    expect(t.for + t.against + t.abstain).toBeLessThanOrEqual(t.present);
  });

  it('drops a vote from somebody who owns nothing here, and keeps the first of two for one contact', () => {
    const t = tallyDecision('share', owners, present(A, B), [
      { contactId: 'c-stranger', choice: 'against' },
      { contactId: B, choice: 'for' },
      { contactId: B, choice: 'against' },
    ]);
    expect(t.for).toBe(3000);
    expect(t.against).toBe(0);
  });

  it('is empty but well-formed for a building nobody attended', () => {
    expect(tallyDecision('share', owners, [], [])).toEqual(
      { for: 0, against: 0, abstain: 0, present: 0, basisTotal: 10000, quorumReached: false, result: 'no_quorum' });
  });

  it('is well-formed for an assembly with no owners at all', () => {
    // 0 × 2 > 0 is false, so an empty building never has a quorum and never decides anything.
    expect(tallyDecision('share', [], [], [])).toEqual(
      { for: 0, against: 0, abstain: 0, present: 0, basisTotal: 0, quorumReached: false, result: 'no_quorum' });
  });
});

describe('mk pack assembly labels', () => {
  it('carries the Art. 37 sentences the invitation and the minutes print', () => {
    expect(mkPack.labels.assemblyInvitationIntro).toContain('собир');
    expect(mkPack.labels.assemblyLegal).toContain('член 37');
    expect(mkPack.labels.assemblyLegal).toContain('15');
  });
});
