import { z } from 'zod';
import { boolQuery, dedupe, moneyMinor, nullableStr, unitKindEnum } from '../common.js';

export const pricingEnum = z.enum(['fixed_per_unit', 'per_m2', 'shared_total']);
export const serviceOut = z.object({
  id: z.string(), name: z.string(), category: z.string().nullable(), description: z.string().nullable(), pricing: pricingEnum,
  defaultPriceMinor: z.number().int(), taxRateId: z.string().nullable(), taxRateBp: z.number().int(), appliesTo: z.array(unitKindEnum),
  recurring: z.boolean(), isActive: z.boolean(), createdAt: z.date().or(z.string()), updatedAt: z.date().or(z.string()),
});
export const serviceCreate = z.object({
  name: z.string().min(1).max(200), category: nullableStr(100), description: nullableStr(2000), pricing: pricingEnum,
  defaultPriceMinor: moneyMinor.default(0), taxRateId: z.string().uuid().nullable().optional(),
  appliesTo: z.array(unitKindEnum).max(5).default([]).transform(dedupe), recurring: z.boolean().default(true),
});
export const servicePatch = z.object({
  name: z.string().min(1).max(200).optional(), category: nullableStr(100), description: nullableStr(2000), pricing: pricingEnum.optional(),
  defaultPriceMinor: moneyMinor.optional(), taxRateId: z.string().uuid().nullable().optional(),
  appliesTo: z.array(unitKindEnum).max(5).transform(dedupe).optional(), recurring: z.boolean().optional(),
});
export const serviceListQuery = z.object({ includeInactive: boolQuery.optional(), recurring: boolQuery.optional() });
export type ServiceCreate = z.infer<typeof serviceCreate>;
export type ServicePatch = z.infer<typeof servicePatch>;
