import { z } from 'zod';
import { idParam } from '../common.js';

export const taxRateOut = z.object({
  id: z.string(), name: z.string(), rateBp: z.number().int(), isDefault: z.boolean(), isActive: z.boolean(),
  createdAt: z.date().or(z.string()), updatedAt: z.date().or(z.string()),
});
export const taxRateCreate = z.object({ name: z.string().min(1).max(100), rateBp: z.number().int().min(0).max(10_000), isDefault: z.boolean().optional() });
export const taxRatePatch = taxRateCreate.partial();
export { idParam };
export const listQuery = z.object({ includeInactive: z.enum(['true', 'false']).transform((v) => v === 'true').optional() });
export type TaxRateCreate = z.infer<typeof taxRateCreate>;
export type TaxRatePatch = z.infer<typeof taxRatePatch>;
