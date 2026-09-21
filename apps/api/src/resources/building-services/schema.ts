import { z } from 'zod';
import { comparePeriods } from '@domar/domain';
import { moneyMinor, periodStr, unitKindEnum } from '../common.js';
import { pricingEnum } from '../services/schema.js';

export const frequencyEnum = z.enum(['monthly', 'every_n_months']);
const base = z.object({
  priceMinor: moneyMinor.nullable().optional(),
  pricing: pricingEnum.nullable().optional(),
  frequency: frequencyEnum.default('monthly'),
  intervalMonths: z.number().int().min(1).max(24).default(1),
  startsPeriod: periodStr,
  endsPeriod: periodStr.nullable().optional(),
});
const rules = (v: { frequency: string; intervalMonths: number; startsPeriod?: string | undefined; endsPeriod?: string | null | undefined }, ctx: z.RefinementCtx) => {
  if (v.frequency === 'every_n_months' && v.intervalMonths < 2) ctx.addIssue({ code: 'custom', path: ['intervalMonths'], message: 'intervalMonths must be ≥ 2 for every_n_months' });
  if (v.startsPeriod && v.endsPeriod && comparePeriods(v.endsPeriod, v.startsPeriod) < 0) ctx.addIssue({ code: 'custom', path: ['endsPeriod'], message: 'endsPeriod must not precede startsPeriod' });
};
export const buildingServiceCreate = base.extend({ serviceId: z.string().uuid() }).superRefine(rules);
export const buildingServicePatch = base.partial().extend({ isActive: z.boolean().optional() }).superRefine((v, ctx) => {
  if (v.frequency === 'every_n_months' && v.intervalMonths !== undefined && v.intervalMonths < 2) {
    ctx.addIssue({ code: 'custom', path: ['intervalMonths'], message: 'intervalMonths must be ≥ 2 for every_n_months' });
  }
  if (v.startsPeriod && v.endsPeriod && comparePeriods(v.endsPeriod, v.startsPeriod) < 0) {
    ctx.addIssue({ code: 'custom', path: ['endsPeriod'], message: 'endsPeriod must not precede startsPeriod' });
  }
});
export const buildingServiceOut = z.object({
  id: z.string(), buildingId: z.string(), serviceId: z.string(), priceMinor: z.number().int().nullable(), pricing: pricingEnum.nullable(),
  frequency: frequencyEnum, intervalMonths: z.number().int(), startsPeriod: z.string(), endsPeriod: z.string().nullable(), isActive: z.boolean(),
  effectivePriceMinor: z.number().int(), effectivePricing: pricingEnum,
  service: z.object({ id: z.string(), name: z.string(), pricing: pricingEnum, defaultPriceMinor: z.number().int(), taxRateBp: z.number().int(), appliesTo: z.array(unitKindEnum), isActive: z.boolean() }),
  createdAt: z.date().or(z.string()), updatedAt: z.date().or(z.string()),
});
export type BuildingServiceCreate = z.infer<typeof buildingServiceCreate>;
export type BuildingServicePatch = z.infer<typeof buildingServicePatch>;
