import { describe, expect, it } from 'vitest';
import { comparePeriods, isServiceDue, isValidPeriod, localDayStart, monthsBetween, nextPeriod, periodStartDate } from '../src/period.js';

describe('period helpers', () => {
  it('validates YYYY-MM', () => {
    expect(isValidPeriod('2026-09')).toBe(true);
    expect(isValidPeriod('2026-13')).toBe(false);
    expect(isValidPeriod('2026-9')).toBe(false);
    expect(isValidPeriod('202609')).toBe(false);
    expect(isValidPeriod('0026-01')).toBe(false);
  });
  it('compares and steps periods', () => {
    expect(comparePeriods('2026-09', '2026-10')).toBeLessThan(0);
    expect(comparePeriods('2026-10', '2026-10')).toBe(0);
    expect(nextPeriod('2026-12')).toBe('2027-01');
    expect(monthsBetween('2026-01', '2026-09')).toBe(8);
    expect(monthsBetween('2025-11', '2026-02')).toBe(3);
    expect(monthsBetween('2026-09', '2026-01')).toBe(-8);
  });
  it('gives the UTC instant of local midnight on the 1st', () => {
    expect(periodStartDate('2026-09', 'Europe/Skopje').toISOString()).toBe('2026-08-31T22:00:00.000Z'); // CEST = UTC+2
    expect(periodStartDate('2026-01', 'Europe/Skopje').toISOString()).toBe('2025-12-31T23:00:00.000Z'); // CET = UTC+1
  });
  it('gives the correct offset near a DST transition, for a zone ahead of UTC', () => {
    // Australia/Sydney: DST (AEDT, +11) starts Sun 4 Oct 2026 and ends Sun 5 Apr 2026, so the
    // 1st of each of these months falls a few days before the transition, on the side shown.
    expect(periodStartDate('2026-10', 'Australia/Sydney').toISOString()).toBe('2026-09-30T14:00:00.000Z'); // AEST = UTC+10
    expect(periodStartDate('2026-04', 'Australia/Sydney').toISOString()).toBe('2026-03-31T13:00:00.000Z'); // AEDT = UTC+11
  });
  it('decides when a recurring service is due', () => {
    const monthly = { frequency: 'monthly' as const, intervalMonths: 1, startsPeriod: '2026-03', endsPeriod: null };
    expect(isServiceDue('2026-02', monthly)).toBe(false);
    expect(isServiceDue('2026-03', monthly)).toBe(true);
    expect(isServiceDue('2027-07', monthly)).toBe(true);
    const quarterly = { frequency: 'every_n_months' as const, intervalMonths: 3, startsPeriod: '2026-01', endsPeriod: '2026-12' };
    expect(isServiceDue('2026-01', quarterly)).toBe(true);
    expect(isServiceDue('2026-02', quarterly)).toBe(false);
    expect(isServiceDue('2026-04', quarterly)).toBe(true);
    expect(isServiceDue('2026-10', quarterly)).toBe(true);
    expect(isServiceDue('2027-01', quarterly)).toBe(false); // after endsPeriod
  });
  it('floors every_n_months intervalMonths at 1, so 1 (or less) means every period', () => {
    const everyOne = { frequency: 'every_n_months' as const, intervalMonths: 1, startsPeriod: '2026-01', endsPeriod: null };
    expect(isServiceDue('2026-01', everyOne)).toBe(true);
    expect(isServiceDue('2026-02', everyOne)).toBe(true);
    expect(isServiceDue('2026-06', everyOne)).toBe(true);
    const everyZero = { frequency: 'every_n_months' as const, intervalMonths: 0, startsPeriod: '2026-01', endsPeriod: null };
    expect(isServiceDue('2026-01', everyZero)).toBe(true);
    expect(isServiceDue('2026-03', everyZero)).toBe(true); // 0 treated as 1
  });
});

describe('localDayStart', () => {
  it('is the UTC instant of local midnight in the zone', () => {
    // Skopje is UTC+2 in September (CEST), so local midnight is 22:00 UTC the day before.
    expect(localDayStart(new Date('2026-09-24T09:30:00.000Z'), 'Europe/Skopje').toISOString()).toBe('2026-09-23T22:00:00.000Z');
    // ... and UTC+1 in January (CET).
    expect(localDayStart(new Date('2026-01-15T09:30:00.000Z'), 'Europe/Skopje').toISOString()).toBe('2026-01-14T23:00:00.000Z');
    expect(localDayStart(new Date('2026-09-24T09:30:00.000Z'), 'UTC').toISOString()).toBe('2026-09-24T00:00:00.000Z');
  });
  it('picks the local day, not the UTC day', () => {
    // 23:30 UTC on the 23rd is already 01:30 on the 24th in Skopje.
    expect(localDayStart(new Date('2026-09-23T23:30:00.000Z'), 'Europe/Skopje').toISOString()).toBe('2026-09-23T22:00:00.000Z');
  });
  it('gives the correct offset on the day Europe/Skopje springs forward', () => {
    // 2026-03-29: clocks jump 02:00→03:00 CET→CEST at 01:00 UTC. Local midnight of the 29th itself
    // is still CET (+1), before the day's own transition.
    expect(localDayStart(new Date('2026-03-29T09:30:00.000Z'), 'Europe/Skopje').toISOString()).toBe('2026-03-28T23:00:00.000Z');
  });
  it('gives the correct offset on the day Europe/Skopje falls back', () => {
    // 2026-10-25: clocks fall 03:00→02:00 CEST→CET at 01:00 UTC. Local midnight of the 25th itself
    // is still CEST (+2), before the day's own transition.
    expect(localDayStart(new Date('2026-10-25T09:30:00.000Z'), 'Europe/Skopje').toISOString()).toBe('2026-10-24T22:00:00.000Z');
  });
});
