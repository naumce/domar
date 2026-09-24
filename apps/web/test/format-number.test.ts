import { expect, it } from 'vitest';
import { formatNumber } from '../src/utils/money';
it('formats mk numbers without Intl', () => {
  expect(formatNumber(54.5)).toBe('54,5'); expect(formatNumber(1234.5)).toBe('1.234,5'); expect(formatNumber(50)).toBe('50');
  expect(formatNumber(0.085, 3)).toBe('0,085'); expect(formatNumber(-1200)).toBe('-1.200'); expect(formatNumber(null)).toBe('—'); expect(formatNumber(1000000.25)).toBe('1.000.000,25');
});
