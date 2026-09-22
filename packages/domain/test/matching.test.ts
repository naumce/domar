import { describe, expect, it } from 'vitest';
import { matchLine, matchStatementLines, normalizeRef } from '../src/statements/index.js';

const cands = [
  { invoiceId: 'i1', number: 'INV-0001/2026', contactLastName: 'Марков', outstandingMinor: 2560999 },
  { invoiceId: 'i2', number: 'INV-0002/2026', contactLastName: 'Бошковски', outstandingMinor: 3540570 },
  { invoiceId: 'i3', number: 'INV-0003/2026', contactLastName: 'Велковски', outstandingMinor: 3540570 },
];
const line = (amountMinor: number, reference: string, counterparty = '') => ({ bookedAt: '2026-09-15', amountMinor, reference, counterparty, raw: '' });

describe('normalizeRef', () => {
  it('uppercases, transliterates Cyrillic and strips noise', () => {
    expect(normalizeRef('inv-0001 / 2026 стан 12')).toBe('INV-0001/2026STAN12');
    expect(normalizeRef('Бошковски Ѓорѓи')).toBe('BOSKOVSKIGJORGJI');
  });
});

describe('matchLine', () => {
  it('matches exactly on the invoice number anywhere in the reference', () => {
    expect(matchLine(line(100, 'Uplata inv 0001/2026 za stan'), cands)).toEqual({ invoiceId: 'i1', confidence: 'exact' });
    expect(matchLine(line(100, 'INV-0002/2026'), cands)).toEqual({ invoiceId: 'i2', confidence: 'exact' });
  });
  it('matches likely on amount plus surname in reference or counterparty', () => {
    expect(matchLine(line(2560999, 'uplata za septemvri', 'MARKO MARKOV'), cands)).toEqual({ invoiceId: 'i1', confidence: 'likely' });
    expect(matchLine(line(2560999, 'Марков септември'), cands)).toEqual({ invoiceId: 'i1', confidence: 'likely' });
  });
  it('returns null when the amount matches several invoices without a surname, or nothing matches, or the line is a debit', () => {
    expect(matchLine(line(3540570, 'uplata'), cands)).toBeNull();
    expect(matchLine(line(3540570, 'uplata', 'Boskovski'), cands)).toEqual({ invoiceId: 'i2', confidence: 'likely' });
    expect(matchLine(line(999, 'nothing'), cands)).toBeNull();
    expect(matchLine(line(-2560999, 'INV-0001/2026'), cands)).toBeNull();
  });
  it('maps a batch with indices', () => {
    expect(matchStatementLines([line(1, 'x'), line(5, 'INV-0003/2026')], cands)).toEqual([{ index: 1, invoiceId: 'i3', confidence: 'exact' }]);
  });
});
