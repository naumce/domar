import { describe, expect, it } from 'vitest';
import { mkPack } from '../src/country/mk.js';
import { evaluateOwner, type PriorReminder, type UnpaidInvoice } from '../src/reminders/evaluate.js';

const RULES = mkPack.reminderRules;
const TODAY = new Date('2026-09-24T09:00:00.000Z');
const inv = (id: string, period: string, dueAt: string, outstandingMinor = 354000): UnpaidInvoice => ({ id, period, dueAt, outstandingMinor });
const run = (invoices: UnpaidInvoice[], priorReminders: PriorReminder[] = []) => evaluateOwner({ invoices, priorReminders }, RULES, TODAY);

describe('evaluateOwner (Art. 28)', () => {
  it('is due for two consecutive overdue periods', () => {
    const r = run([inv('b', '2026-08', '2026-08-20T00:00:00.000Z'), inv('a', '2026-07', '2026-07-20T00:00:00.000Z')]);
    expect(r).toEqual({ due: true, reason: 'consecutive', invoiceIds: ['a', 'b'] });
  });

  it('treats December → January as consecutive', () => {
    const r = run([inv('x', '2025-12', '2025-12-20T00:00:00.000Z'), inv('y', '2026-01', '2026-01-20T00:00:00.000Z')]);
    expect(r.due).toBe(true);
    expect(r.reason).toBe('consecutive');
  });

  it('is due for three non-consecutive overdue periods, with reason total', () => {
    const r = run([
      inv('i1', '2026-01', '2026-01-20T00:00:00.000Z'),
      inv('i2', '2026-03', '2026-03-20T00:00:00.000Z'),
      inv('i3', '2026-05', '2026-05-20T00:00:00.000Z'),
    ]);
    expect(r).toEqual({ due: true, reason: 'total', invoiceIds: ['i1', 'i2', 'i3'] });
  });

  it('is not due for two non-consecutive overdue periods', () => {
    const r = run([inv('i1', '2026-01', '2026-01-20T00:00:00.000Z'), inv('i2', '2026-03', '2026-03-20T00:00:00.000Z')]);
    expect(r).toEqual({ due: false, reason: null, invoiceIds: [] });
  });

  it('counts distinct periods, not invoices, when two invoices share a period', () => {
    const r = run([
      inv('a', '2026-07', '2026-07-20T00:00:00.000Z'),
      inv('b', '2026-07', '2026-07-25T00:00:00.000Z'),
      inv('c', '2026-08', '2026-08-20T00:00:00.000Z'),
    ]);
    expect(r).toEqual({ due: true, reason: 'consecutive', invoiceIds: ['a', 'b', 'c'] });
  });

  it('is not due when all overdue invoices share a single period', () => {
    const r = run([
      inv('a', '2026-01', '2026-01-20T00:00:00.000Z'),
      inv('b', '2026-01', '2026-01-22T00:00:00.000Z'),
      inv('c', '2026-01', '2026-01-25T00:00:00.000Z'),
    ]);
    expect(r).toEqual({ due: false, reason: null, invoiceIds: [] });
  });

  it('ignores invoices that are not past their due date', () => {
    const r = run([inv('a', '2026-08', '2026-08-20T00:00:00.000Z'), inv('b', '2026-09', '2026-10-09T00:00:00.000Z')]);
    expect(r).toEqual({ due: false, reason: null, invoiceIds: [] });
  });

  it('ignores invoices with nothing outstanding', () => {
    const r = run([inv('a', '2026-07', '2026-07-20T00:00:00.000Z', 0), inv('b', '2026-08', '2026-08-20T00:00:00.000Z')]);
    expect(r).toEqual({ due: false, reason: null, invoiceIds: [] });
  });

  it('suppresses the same set inside 30 days', () => {
    const prior: PriorReminder = { sentAt: '2026-09-10T09:00:00.000Z', invoiceIds: ['a', 'b'] };
    const r = run([inv('a', '2026-07', '2026-07-20T00:00:00.000Z'), inv('b', '2026-08', '2026-08-20T00:00:00.000Z')], [prior]);
    expect(r).toEqual({ due: false, reason: null, invoiceIds: [] });
  });

  it('still suppresses just under the 30 day threshold', () => {
    const sentAt = new Date(TODAY.getTime() - (29 * 24 + 23) * 60 * 60 * 1000).toISOString(); // 29 days 23 hours before TODAY
    const prior: PriorReminder = { sentAt, invoiceIds: ['a', 'b'] };
    const r = run([inv('a', '2026-07', '2026-07-20T00:00:00.000Z'), inv('b', '2026-08', '2026-08-20T00:00:00.000Z')], [prior]);
    expect(r.due).toBe(false);
  });

  it('sends again once the prior reminder is 30 days old', () => {
    const prior: PriorReminder = { sentAt: '2026-08-25T09:00:00.000Z', invoiceIds: ['a', 'b'] }; // 30 days before TODAY
    const r = run([inv('a', '2026-07', '2026-07-20T00:00:00.000Z'), inv('b', '2026-08', '2026-08-20T00:00:00.000Z')], [prior]);
    expect(r.due).toBe(true);
  });

  it('sends again when a new invoice joins the set', () => {
    const prior: PriorReminder = { sentAt: '2026-09-10T09:00:00.000Z', invoiceIds: ['a', 'b'] };
    const r = run([
      inv('a', '2026-07', '2026-07-20T00:00:00.000Z'),
      inv('b', '2026-08', '2026-08-20T00:00:00.000Z'),
      inv('c', '2026-09', '2026-09-20T00:00:00.000Z'),
    ], [prior]);
    expect(r).toEqual({ due: true, reason: 'consecutive', invoiceIds: ['a', 'b', 'c'] });
  });

  it('stays suppressed when the prior reminder covered more invoices than are still open', () => {
    const prior: PriorReminder = { sentAt: '2026-09-10T09:00:00.000Z', invoiceIds: ['a', 'b', 'c'] };
    const r = run([inv('a', '2026-07', '2026-07-20T00:00:00.000Z'), inv('b', '2026-08', '2026-08-20T00:00:00.000Z')], [prior]);
    expect(r.due).toBe(false);
  });

  it('is due when a prior reminder covers a disjoint set of invoices', () => {
    const prior: PriorReminder = { sentAt: '2026-09-20T09:00:00.000Z', invoiceIds: ['x', 'y'] };
    const r = run([inv('a', '2026-07', '2026-07-20T00:00:00.000Z'), inv('b', '2026-08', '2026-08-20T00:00:00.000Z')], [prior]);
    expect(r).toEqual({ due: true, reason: 'consecutive', invoiceIds: ['a', 'b'] });
  });

  it('returns nothing for an owner with no overdue invoices', () => {
    expect(run([])).toEqual({ due: false, reason: null, invoiceIds: [] });
  });

  it('produces the same result regardless of invoice order', () => {
    const invoices = [
      inv('i1', '2026-01', '2026-01-20T00:00:00.000Z'),
      inv('i2', '2026-03', '2026-03-20T00:00:00.000Z'),
      inv('i3', '2026-05', '2026-05-20T00:00:00.000Z'),
    ];
    const forward = run(invoices);
    const reversed = run([...invoices].reverse());
    expect(reversed).toEqual(forward);
  });
});

describe('mk reminder labels', () => {
  it('forbids a fee and cites Art. 28', () => {
    expect(mkPack.reminderRules.feeAllowed).toBe(false);
    expect(mkPack.reminderRules.consecutiveUnpaid).toBe(2);
    expect(mkPack.reminderRules.totalUnpaid).toBe(3);
    expect(mkPack.labels.reminderLegal).toContain('член 28');
    expect(mkPack.labels.reminderLegal).toContain('Законот за домување');
    expect(mkPack.labels.reminderIntro).toContain('не се платени');
  });
});
