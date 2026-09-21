/** Round half away from zero to an integer. */
export function roundHalfUp(value: number): number {
  const sign = value < 0 ? -1 : 1;
  return sign * Math.floor(Math.abs(value) + 0.5 + Number.EPSILON);
}

/** price (minor units) × decimal quantity, rounded half up to minor units. */
export function mulMinor(priceMinor: number, quantity: number): number {
  return roundHalfUp(priceMinor * quantity);
}

/** Apply a tax rate in basis points (1800 = 18%). */
export function applyTaxBp(netMinor: number, rateBp: number): { taxMinor: number; grossMinor: number } {
  const taxMinor = roundHalfUp((netMinor * rateBp) / 10_000);
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
