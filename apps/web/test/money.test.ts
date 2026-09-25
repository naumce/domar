import { describe, expect, it } from 'vitest';
import { formatDateTime, formatMoney, percentFromBp, toMinor } from '@/utils/money';

describe('money utils', () => {
  it('formats MKD minor units the Macedonian way', () => {
    expect(formatMoney(123456789)).toBe('1.234.567,89 ден.');
    expect(formatMoney(-50)).toBe('-0,50 ден.');
    expect(formatMoney(0)).toBe('0,00 ден.');
  });
  it('parses user input to minor units', () => {
    expect(toMinor('1234,56')).toBe(123456);
    expect(toMinor('1234.56')).toBe(123456);
    expect(toMinor('1.234,5')).toBe(123450);
    expect(toMinor('1.234')).toBe(123400);
    expect(toMinor('0.285')).toBe(29);
    expect(toMinor('-12')).toBe(-1200);
    expect(toMinor('300')).toBe(30000);
    expect(toMinor('')).toBeNull();
    expect(toMinor('abc')).toBeNull();
  });
  it('converts basis points to percent text', () => {
    expect(percentFromBp(1800)).toBe('18,00 %');
    expect(percentFromBp(0)).toBe('0,00 %');
  });
  it('formats an ISO instant the Macedonian way, in local time', () => {
    const iso = new Date(2026, 8, 25, 9, 4).toISOString();
    expect(formatDateTime(iso)).toBe('25.09.2026 09:04');
  });
});
