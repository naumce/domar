import { describe, expect, it } from 'vitest';
import { allocateAcrossFunds } from '../src/allocation.js';

describe('allocateAcrossFunds', () => {
  it('splits proportionally to fund totals with largest remainder', () => {
    expect(allocateAcrossFunds(100000, { regular: 206099, reserve: 50000 })).toEqual({ regular: 80476, reserve: 19524 });
  });
  it('puts everything on regular when totals are zero or missing', () => {
    expect(allocateAcrossFunds(500, {})).toEqual({ regular: 500, reserve: 0 });
    expect(allocateAcrossFunds(500, { regular: 0, reserve: 0 })).toEqual({ regular: 500, reserve: 0 });
  });
  it('handles a reserve-only invoice', () => {
    expect(allocateAcrossFunds(700, { reserve: 700 })).toEqual({ regular: 0, reserve: 700 });
  });
});
