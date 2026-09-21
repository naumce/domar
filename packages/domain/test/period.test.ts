import { describe, expect, it } from 'vitest';
import { comparePeriods, isServiceDue, isValidPeriod, monthsBetween, nextPeriod, periodStartDate } from '../src/period.js';

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
