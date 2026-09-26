import { describe, expect, it } from 'vitest';
import {
  buildJournal, chartFrom, JournalError, missingSlots,
  type Chart, type JournalInput, type JournalPostingIn,
} from '../src/accounting/journal.js';
import { ACCOUNT_SLOTS } from '../src/accounting/slots.js';

/** A code per slot, numbered so a wrong slot in the output is obvious by eye. */
const CHART: Chart = chartFrom(ACCOUNT_SLOTS.map((slot, i) => ({ slot, code: `${120 + i}`, name: slot, isActive: true })));

function posting(p: Partial<JournalPostingIn> & Pick<JournalPostingIn, 'id' | 'amountMinor' | 'refType'>): JournalPostingIn {
  return {
    account: 'owner', fund: 'regular', kind: 'charge', refId: null, period: '2026-09', date: '2026-09-15',
    buildingName: 'Јане Сандански 5', counterparty: 'Марко Марков', prior: false, ...p,
  };
}
const input = (over: Partial<JournalInput>): JournalInput =>
  ({ chart: CHART, postings: [], invoices: {}, expenses: {}, closedPeriods: [], ...over });

describe('missingSlots', () => {
  it('names every slot that has no active code, in the canonical order', () => {
    expect(missingSlots([
      { slot: 'owner_receivable', code: '120', isActive: true },
      { slot: 'vat_output', code: '260', isActive: false },
      { slot: 'cash_regular', code: '', isActive: true },
    ])).toEqual(['revenue_service', 'revenue_management_fee', 'revenue_reserve_fund', 'vat_output', 'cash_regular', 'cash_reserve', 'expense_default', 'opening_balance']);
  });

  it('is empty for a complete chart', () => {
    expect(missingSlots(ACCOUNT_SLOTS.map((slot) => ({ slot, code: '1', isActive: true })))).toEqual([]);
  });
});

describe('chartFrom', () => {
  it('maps every slot to its own code and name', () => {
    const rows = ACCOUNT_SLOTS.map((slot, i) => ({ slot, code: `${200 + i}`, name: `${slot} name`, isActive: true }));
    const chart = chartFrom(rows);
    expect(chart.owner_receivable).toEqual({ code: '200', name: 'owner_receivable name' });
    expect(chart.opening_balance).toEqual({ code: `${200 + ACCOUNT_SLOTS.length - 1}`, name: 'opening_balance name' });
  });

  it('agrees with missingSlots that a blank code is not a mapping, even when the row is active', () => {
    const rows = ACCOUNT_SLOTS.map((slot) => ({ slot, code: slot === 'vat_output' ? '' : '1', name: slot, isActive: true }));
    expect(missingSlots(rows)).toEqual(['vat_output']);
    expect(() => chartFrom(rows)).toThrow(RangeError);
  });

  it('agrees with missingSlots that a disabled row is not a mapping, even with a code', () => {
    const rows = ACCOUNT_SLOTS.map((slot) => ({ slot, code: '1', name: slot, isActive: slot !== 'cash_regular' }));
    expect(missingSlots(rows)).toEqual(['cash_regular']);
    expect(() => chartFrom(rows)).toThrow(RangeError);
  });
});

describe('buildJournal — an invoice', () => {
  // 3.000,00 service net + 540,00 VAT, 1.000,00 reserve fund, 500,00 management fee: gross 5.040,00.
  const j = buildJournal(input({
    postings: [
      posting({ id: 'p1', amountMinor: 354000, refType: 'invoice', refId: 'inv1' }),
      posting({ id: 'p2', amountMinor: 100000, refType: 'invoice', refId: 'inv1', fund: 'reserve' }),
      posting({ id: 'p3', amountMinor: 50000, refType: 'invoice', refId: 'inv1' }),
    ],
    invoices: {
      inv1: {
        number: 'INV-1/2026',
        lines: [
          { kind: 'service', ownerNetMinor: 300000, ownerTaxMinor: 54000, ownerGrossMinor: 354000 },
          { kind: 'reserve_fund', ownerNetMinor: 100000, ownerTaxMinor: 0, ownerGrossMinor: 100000 },
          { kind: 'management_fee', ownerNetMinor: 50000, ownerTaxMinor: 0, ownerGrossMinor: 50000 },
        ],
      },
    },
  }));

  it('debits the receivable gross and credits revenue net plus output VAT', () => {
    expect(j.entries).toHaveLength(1);
    const lines = j.entries[0]!.lines.map((l) => [l.name, l.debitMinor, l.creditMinor]);
    expect(lines).toEqual([
      ['owner_receivable', 504000, 0],
      ['revenue_service', 0, 300000],
      ['revenue_management_fee', 0, 50000],
      ['revenue_reserve_fund', 0, 100000],
      ['vat_output', 0, 54000],
    ]);
  });

  it('carries the invoice number, the source and the period', () => {
    expect(j.entries[0]).toMatchObject({ no: 1, sourceType: 'invoice', sourceId: 'inv1', period: '2026-09', date: '2026-09-15' });
    expect(j.entries[0]!.lines[0]!.description).toBe('INV-1/2026');
  });
});

describe('buildJournal — a manual line is service revenue', () => {
  it('books `manual` to revenue_service, the same slot as `service`', () => {
    const j = buildJournal(input({
      postings: [posting({ id: 'p1', amountMinor: 20000, refType: 'invoice', refId: 'inv2' })],
      invoices: { inv2: { number: 'INV-2/2026', lines: [{ kind: 'manual', ownerNetMinor: 20000, ownerTaxMinor: 0, ownerGrossMinor: 20000 }] } },
    }));
    expect(j.entries[0]!.lines.map((l) => l.name)).toEqual(['owner_receivable', 'revenue_service']);
  });
});

describe('buildJournal — a credit note reverses the sides', () => {
  it('a negative gross, net and tax flip to the other side rather than posting a negative line', () => {
    const j = buildJournal(input({
      postings: [posting({ id: 'p1', amountMinor: -118000, refType: 'invoice', refId: 'cn1' })],
      invoices: {
        cn1: { number: 'CN-1/2026', lines: [{ kind: 'service', ownerNetMinor: -100000, ownerTaxMinor: -18000, ownerGrossMinor: -118000 }] },
      },
    }));
    expect(j.entries[0]!.lines.map((l) => [l.name, l.debitMinor, l.creditMinor])).toEqual([
      ['owner_receivable', 0, 118000],
      ['revenue_service', 100000, 0],
      ['vat_output', 18000, 0],
    ]);
  });
});

describe('buildJournal — money in and out', () => {
  it('a payment debits the fund cash account and credits the receivable', () => {
    const j = buildJournal(input({
      postings: [
        posting({ id: 'p1', amountMinor: -80000, refType: 'payment', refId: 'pay1', kind: 'payment' }),
        posting({ id: 'p2', amountMinor: 80000, refType: 'payment', refId: 'pay1', kind: 'payment', account: 'fund' }),
        posting({ id: 'p3', amountMinor: -20000, refType: 'payment', refId: 'pay1', kind: 'payment', fund: 'reserve' }),
        posting({ id: 'p4', amountMinor: 20000, refType: 'payment', refId: 'pay1', kind: 'payment', account: 'fund', fund: 'reserve' }),
      ],
    }));
    expect(j.entries).toHaveLength(1);
    expect(j.entries[0]!.lines.map((l) => [l.name, l.debitMinor, l.creditMinor])).toEqual([
      ['cash_regular', 80000, 0],
      ['cash_reserve', 20000, 0],
      ['owner_receivable', 0, 100000],
    ]);
  });

  it('a voided payment is the same entry the other way round', () => {
    const j = buildJournal(input({
      postings: [
        posting({ id: 'p1', amountMinor: 80000, refType: 'payment_void', refId: 'pay1', kind: 'adjustment' }),
        posting({ id: 'p2', amountMinor: -80000, refType: 'payment_void', refId: 'pay1', kind: 'adjustment', account: 'fund' }),
      ],
    }));
    expect(j.entries[0]!.lines.map((l) => [l.name, l.debitMinor, l.creditMinor])).toEqual([
      ['owner_receivable', 80000, 0],
      ['cash_regular', 0, 80000],
    ]);
  });

  it('an expense debits the supplier account when it has one and the default when it has not', () => {
    const j = buildJournal(input({
      postings: [
        posting({ id: 'p1', amountMinor: -60000, refType: 'expense', refId: 'e1', kind: 'expense', account: 'fund', counterparty: 'ЕВН' }),
        posting({ id: 'p2', amountMinor: -30000, refType: 'expense', refId: 'e2', kind: 'expense', account: 'fund', fund: 'reserve', counterparty: 'Лифт Сервис' }),
      ],
      expenses: {
        e1: { description: 'Струја', account: { code: '4030', name: 'Електрична енергија' } },
        e2: { description: 'Поправка на лифт', account: null },
      },
    }));
    expect(j.entries.map((e) => e.lines.map((l) => [l.name, l.debitMinor, l.creditMinor]))).toEqual([
      [['Електрична енергија', 60000, 0], ['cash_regular', 0, 60000]],
      [['expense_default', 30000, 0], ['cash_reserve', 0, 30000]],
    ]);
  });

  it('a voided expense reverses the pair', () => {
    const j = buildJournal(input({
      postings: [posting({ id: 'p1', amountMinor: 60000, refType: 'expense_void', refId: 'e1', kind: 'adjustment', account: 'fund' })],
      expenses: { e1: { description: 'Струја', account: null } },
    }));
    expect(j.entries[0]!.lines.map((l) => [l.name, l.debitMinor, l.creditMinor])).toEqual([
      ['cash_regular', 60000, 0],
      ['expense_default', 0, 60000],
    ]);
  });

  it('refuses an expense group of more than one posting rather than dropping one of them', () => {
    const run = () => buildJournal(input({
      postings: [
        posting({ id: 'p1', amountMinor: -30000, refType: 'expense', refId: 'e1', kind: 'expense', account: 'fund' }),
        posting({ id: 'p2', amountMinor: -30000, refType: 'expense', refId: 'e1', kind: 'expense', account: 'fund' }),
      ],
      expenses: { e1: { description: 'Струја', account: null } },
    }));
    expect(run).toThrow(JournalError);
    try { run(); } catch (e) {
      expect((e as JournalError).code).toBe('unknown_source');
      expect((e as JournalError).details).toMatchObject({ refType: 'expense', refId: 'e1', postingCount: 2 });
    }
  });
});

describe('buildJournal — opening balances follow the sign', () => {
  it('an owner who owes is a debit and an owner in credit is the reverse', () => {
    const j = buildJournal(input({
      postings: [
        posting({ id: 'p1', amountMinor: 45000, refType: 'opening_balance', kind: 'opening' }),
        posting({ id: 'p2', amountMinor: -15000, refType: 'opening_balance', kind: 'opening' }),
        posting({ id: 'p3', amountMinor: 900000, refType: 'opening_balance', kind: 'opening', account: 'fund', fund: 'reserve' }),
        // The fourth sign/account combination: a fund account, negative — a negative opening cash
        // balance, e.g. correcting an overstated float.
        posting({ id: 'p4', amountMinor: -30000, refType: 'opening_balance', kind: 'opening', account: 'fund' }),
      ],
    }));
    expect(j.entries.map((e) => e.lines.map((l) => [l.name, l.debitMinor, l.creditMinor]))).toEqual([
      [['owner_receivable', 45000, 0], ['opening_balance', 0, 45000]],
      [['owner_receivable', 0, 15000], ['opening_balance', 15000, 0]],
      [['cash_reserve', 900000, 0], ['opening_balance', 0, 900000]],
      [['cash_regular', 0, 30000], ['opening_balance', 30000, 0]],
    ]);
    // `refId` is null on an opening balance, so each posting is its own entry.
    expect(j.entries.map((e) => e.sourceId)).toEqual(['p1', 'p2', 'p3', 'p4']);
  });
});

describe('buildJournal — balance is an invariant', () => {
  it('refuses an invoice whose lines do not add up to its postings, naming the entry and the gap', () => {
    const run = () => buildJournal(input({
      postings: [posting({ id: 'p1', amountMinor: 100000, refType: 'invoice', refId: 'inv3' })],
      invoices: { inv3: { number: 'INV-3/2026', lines: [{ kind: 'service', ownerNetMinor: 90000, ownerTaxMinor: 0, ownerGrossMinor: 90000 }] } },
    }));
    expect(run).toThrow(JournalError);
    try { run(); } catch (e) {
      const err = e as JournalError;
      expect(err.code).toBe('unbalanced_entry');
      expect(err.details).toEqual({ entryNo: 1, sourceType: 'invoice', sourceId: 'inv3', differenceMinor: 10000 });
      expect(err.message).toBe('entry 1 (invoice inv3) is out by 10000 minor units');
    }
  });

  it('refuses a posting whose refType it does not know rather than inventing an account', () => {
    const run = () => buildJournal(input({ postings: [posting({ id: 'p1', amountMinor: 1, refType: 'card_settlement' })] }));
    expect(run).toThrow(JournalError);
    try { run(); } catch (e) {
      expect((e as JournalError).code).toBe('unknown_source');
      expect((e as JournalError).details).toEqual({ refType: 'card_settlement', postingId: 'p1' });
    }
  });

  it('refuses an invoice it was handed no lines for', () => {
    const run = () => buildJournal(input({ postings: [posting({ id: 'p1', amountMinor: 1000, refType: 'invoice', refId: 'gone' })] }));
    try { run(); } catch (e) {
      expect((e as JournalError).code).toBe('unknown_source');
      expect((e as JournalError).details).toEqual({ refType: 'invoice', postingId: 'p1', refId: 'gone' });
    }
    expect(run).toThrow(JournalError);
  });
});

describe('buildJournal — the trial balance and the sections', () => {
  const j = buildJournal(input({
    postings: [
      posting({ id: 'p1', amountMinor: 118000, refType: 'invoice', refId: 'inv1', date: '2026-09-01', period: '2026-09' }),
      posting({ id: 'p2', amountMinor: -118000, refType: 'payment', refId: 'pay1', kind: 'payment', date: '2026-09-20', period: '2026-09' }),
      posting({ id: 'p3', amountMinor: 118000, refType: 'payment', refId: 'pay1', kind: 'payment', account: 'fund', date: '2026-09-20', period: '2026-09' }),
      // Booked in August, arrived in September: a prior-period adjustment (spec §5).
      posting({ id: 'p4', amountMinor: -5000, refType: 'payment', refId: 'pay2', kind: 'payment', date: '2026-08-28', period: '2026-08', prior: true }),
      posting({ id: 'p5', amountMinor: 5000, refType: 'payment', refId: 'pay2', kind: 'payment', account: 'fund', date: '2026-08-28', period: '2026-08', prior: true }),
    ],
    invoices: { inv1: { number: 'INV-1/2026', lines: [{ kind: 'service', ownerNetMinor: 100000, ownerTaxMinor: 18000, ownerGrossMinor: 118000 }] } },
    closedPeriods: ['2026-08'],
  }));

  it('splits the entries of the window itself from the prior-period adjustments', () => {
    expect(j.entries.map((e) => e.sourceId)).toEqual(['inv1', 'pay1']);
    expect(j.adjustments.map((e) => e.sourceId)).toEqual(['pay2']);
    expect(j.adjustments[0]).toMatchObject({ period: '2026-08', date: '2026-08-28', closedPeriod: true });
  });

  it('numbers every entry once across both sections', () => {
    expect([...j.entries, ...j.adjustments].map((e) => e.no)).toEqual([1, 2, 3]);
  });

  it('totals each account and the whole file, and the file sums to zero', () => {
    expect(j.trialBalance.map((r) => [r.name, r.debitMinor, r.creditMinor, r.differenceMinor])).toEqual([
      ['owner_receivable', 118000, 123000, -5000],
      ['revenue_service', 0, 100000, -100000],
      ['vat_output', 0, 18000, -18000],
      ['cash_regular', 123000, 0, 123000],
    ]);
    expect(j.totals).toEqual({ debitMinor: 241000, creditMinor: 241000, entryCount: 3, lineCount: 7 });
    expect(j.totals.debitMinor - j.totals.creditMinor).toBe(0);
  });

  it('reports which of the periods it covers were already closed', () => {
    expect(j.closedPeriods).toEqual(['2026-08']);
  });
});

describe('buildJournal — closedPeriod reflects the closed set on its own, not the section', () => {
  it('an entry in the entries section (not `prior`) is still closedPeriod when its own period is closed', () => {
    const j = buildJournal(input({
      postings: [posting({ id: 'p1', amountMinor: 45000, refType: 'opening_balance', kind: 'opening', period: '2026-09' })],
      closedPeriods: ['2026-09'],
    }));
    expect(j.entries).toHaveLength(1);
    expect(j.adjustments).toHaveLength(0);
    expect(j.entries[0]).toMatchObject({ period: '2026-09', closedPeriod: true });
  });
});

describe('buildJournal — a source that moves nothing produces no entry', () => {
  it('an all-zero invoice is skipped rather than numbered as an empty entry', () => {
    const j = buildJournal(input({
      postings: [posting({ id: 'p1', amountMinor: 0, refType: 'invoice', refId: 'inv0' })],
      invoices: { inv0: { number: 'INV-0/2026', lines: [{ kind: 'service', ownerNetMinor: 0, ownerTaxMinor: 0, ownerGrossMinor: 0 }] } },
    }));
    expect(j.entries).toEqual([]);
    expect(j.totals).toEqual({ debitMinor: 0, creditMinor: 0, entryCount: 0, lineCount: 0 });
  });
});

describe('buildJournal — two slots may not share one account code', () => {
  it('refuses a chart that maps one code twice, rather than netting an entry to nothing', () => {
    // `cashLines` merges a payment's two postings by code: on one shared code they cancel, the entry
    // is left with no lines and is skipped, and the file balances with the money gone.
    const shared = chartFrom(ACCOUNT_SLOTS.map((slot) => ({
      slot, code: slot === 'cash_regular' ? '120' : `${120 + ACCOUNT_SLOTS.indexOf(slot)}`, name: slot, isActive: true,
    })));
    expect(() => buildJournal(input({ chart: shared }))).toThrow(JournalError);
    try {
      buildJournal(input({ chart: shared }));
    } catch (e) {
      expect((e as JournalError).code).toBe('duplicate_account_code');
      expect((e as JournalError).details).toEqual({ code: '120', slots: ['owner_receivable', 'cash_regular'] });
    }
  });
});
