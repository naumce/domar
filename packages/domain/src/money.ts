/** Round half away from zero to an integer using only integer arithmetic. */
export function divRoundHalfUp(numerator: number, denominator: number): number {
  if (denominator === 0) throw new RangeError('denominator cannot be zero');
  if (!Number.isInteger(numerator)) throw new RangeError('numerator must be an integer');
  if (!Number.isInteger(denominator)) throw new RangeError('denominator must be an integer');
  const sign = (numerator < 0) !== (denominator < 0) ? -1 : 1;
  const abs = Math.abs(numerator);
  const d = Math.abs(denominator);
  return sign * Math.floor((2 * abs + d) / (2 * d));
}

/** Round half away from zero to an integer; for values already free of float error; money code uses divRoundHalfUp. */
export function roundHalfUp(value: number): number {
  const sign = value < 0 ? -1 : 1;
  return sign * Math.floor(Math.abs(value) + 0.5);
}

/**
 * price (minor units) × decimal quantity. Quantities carry at most 6 decimals; they are scaled to integers first so no float rounding reaches the result.
 * priceMinor × quantity·1e6 must stay below 2^53 (≈9e15): fine for amounts up to ~9e9 minor units with 6-decimal quantities.
 */
export function mulMinor(priceMinor: number, quantity: number): number {
  const q = Math.round(quantity * 1_000_000);
  if (Math.abs(priceMinor) * Math.abs(q) > Number.MAX_SAFE_INTEGER) throw new RangeError('mulMinor overflow');
  return divRoundHalfUp(priceMinor * q, 1_000_000);
}

/** Apply a tax rate in basis points (1800 = 18%). */
export function applyTaxBp(netMinor: number, rateBp: number): { taxMinor: number; grossMinor: number } {
  const taxMinor = divRoundHalfUp(netMinor * rateBp, 10_000);
  return { taxMinor, grossMinor: netMinor + taxMinor };
}

/**
 * Split totalMinor across weights so that parts sum exactly to totalMinor.
 * Largest-remainder method: floor each share, then hand out the leftover units
 * to the shares with the largest fractional parts (ties broken by index).
 */
export function allocateLargestRemainder(totalMinor: number, weights: number[]): number[] {
  if (!Number.isInteger(totalMinor)) throw new RangeError('totalMinor must be an integer');
  const sumW = weights.reduce((a, b) => a + b, 0);
  if (sumW === 0) {
    if (totalMinor === 0) return weights.map(() => 0);
    throw new RangeError('cannot allocate a non-zero total over zero weights');
  }
  const sign = totalMinor < 0 ? -1 : 1;
  const abs = Math.abs(totalMinor);
  const raw = weights.map((w) => (abs * w) / sumW);
  const floors = raw.map((r) => Math.floor(r));
  let remainder = abs - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    if (weights[i] === 0) continue;
    floors[i] = (floors[i] ?? 0) + 1;
    remainder -= 1;
  }
  return floors.map((f) => sign * f);
}
