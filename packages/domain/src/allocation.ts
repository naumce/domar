import { allocateLargestRemainder } from './money.js';

type Fund = 'regular' | 'reserve';

/** Splits a payment across funds proportionally to each fund's outstanding total; zero/missing totals send everything to `regular`. */
export function allocateAcrossFunds(amountMinor: number, fundTotals: Partial<Record<Fund, number>>): Record<Fund, number> {
  const funds: Fund[] = ['regular', 'reserve'];
  const weights = funds.map((f) => Math.max(0, fundTotals[f] ?? 0));
  if (weights.every((w) => w === 0)) return { regular: amountMinor, reserve: 0 };
  const parts = allocateLargestRemainder(amountMinor, weights);
  return { regular: parts[0]!, reserve: parts[1]! };
}
