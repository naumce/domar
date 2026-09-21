import { describe, expect, it } from 'vitest';
import { allocateLargestRemainder, applyTaxBp, divRoundHalfUp, mulMinor, roundHalfUp } from '../src/money.js';

describe('allocateLargestRemainder', () => {
  it('splits evenly when weights are equal', () => {
    expect(allocateLargestRemainder(300, [1, 1, 1])).toEqual([100, 100, 100]);
  });
  it('distributes the remainder to the largest fractional parts and sums to total', () => {
    const parts = allocateLargestRemainder(100, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
    expect(parts.sort()).toEqual([33, 33, 34]);
  });
  it('splits by area weights', () => {
    // 1000 over areas 55.5, 44.5 → 555, 445
    expect(allocateLargestRemainder(1000, [55.5, 44.5])).toEqual([555, 445]);
  });
  it('gives zero to zero weights', () => {
    expect(allocateLargestRemainder(100, [0, 1])).toEqual([0, 100]);
  });
  it('handles negative totals (credits)', () => {
    expect(allocateLargestRemainder(-100, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(-100);
  });
  it('throws when all weights are zero and total is non-zero', () => {
    expect(() => allocateLargestRemainder(10, [0, 0])).toThrow(RangeError);
  });
  it('returns all zeros for zero total', () => {
    expect(allocateLargestRemainder(0, [0, 0])).toEqual([0, 0]);
  });
  it('breaks ties by lowest index', () => {
    expect(allocateLargestRemainder(100, [1, 1, 1])).toEqual([34, 33, 33]);
  });
});

describe('roundHalfUp', () => {
  it('rounds .5 away from zero', () => {
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(-2.5)).toBe(-3);
    expect(roundHalfUp(2.4999)).toBe(2);
  });
});

describe('applyTaxBp', () => {
  it('computes 18% VAT on 1000 minor', () => {
    expect(applyTaxBp(1000, 1800)).toEqual({ taxMinor: 180, grossMinor: 1180 });
  });
  it('rounds tax half up', () => {
    expect(applyTaxBp(1003, 1800)).toEqual({ taxMinor: 181, grossMinor: 1184 }); // 180.54 → 181
  });
  it('zero rate', () => {
    expect(applyTaxBp(999, 0)).toEqual({ taxMinor: 0, grossMinor: 999 });
  });
});

describe('mulMinor', () => {
  it('multiplies price by decimal quantity with rounding', () => {
    expect(mulMinor(1250, 55.5)).toBe(69375);
    expect(mulMinor(333, 1.5)).toBe(500); // 499.5 → 500
  });
  it('handles exact-half products correctly', () => {
    expect(mulMinor(750, 0.018)).toBe(14); // 750*0.018 = 13.5 → 14
    expect(mulMinor(2000000, 0.0000005)).toBe(1); // 2000000*0.0000005 = 1.0 → 1
    expect(mulMinor(-333, 1.5)).toBe(-500); // -333*1.5 = -499.5 → -500
  });
});

describe('divRoundHalfUp', () => {
  it('divides and rounds half away from zero', () => {
    expect(divRoundHalfUp(13, 2)).toBe(7); // 13/2 = 6.5 → 7
    expect(divRoundHalfUp(-13, 2)).toBe(-7); // -13/2 = -6.5 → -7
    expect(divRoundHalfUp(10, 4)).toBe(3); // 10/4 = 2.5 → 3
  });
  it('throws on zero denominator', () => {
    expect(() => divRoundHalfUp(1, 0)).toThrow(RangeError);
  });
});
