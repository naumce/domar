import { z } from 'zod';
import { dedupe, moneyMinor, unitKindEnum } from '../common.js';
import { fundEnum } from '../reserve-fund/schema.js';

export const distributionEnum = z.enum(['share', 'equal', 'area']);

export const extraordinaryCostCreate = z.object({
  description: z.string().min(1).max(300),
  /**
   * Positive, and capped where the engine is still exact: `mulMinor` multiplies by 1e6 internally,
   * so anything above ~9.007e9 minor units overflows `Number.MAX_SAFE_INTEGER` and would throw.
   */
  amountMinor: moneyMinor.min(1).max(9_000_000_000),
  fund: fundEnum,
  distribution: distributionEnum,
  /** Empty or absent = every unit kind, exactly like a period line. */
  appliesTo: z.array(unitKindEnum).max(5).transform(dedupe).optional(),
  dueDays: z.number().int().min(1).max(180),
  documentId: z.string().uuid().nullable().optional(),
});

export const extraordinaryCostOut = z.object({
  periodId: z.string(), period: z.string(), invoiceCount: z.number().int(), totalMinor: z.number().int(),
  invoiceIds: z.array(z.string()),
});
export type ExtraordinaryCostCreate = z.infer<typeof extraordinaryCostCreate>;
