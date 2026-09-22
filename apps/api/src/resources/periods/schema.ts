import { z } from 'zod';
import { dedupe, moneyMinor, nullableStr, periodStr, unitKindEnum } from '../common.js';
import { fundEnum } from '../reserve-fund/schema.js';
import { pricingEnum } from '../services/schema.js';

export const periodStatusEnum = z.enum(['open', 'generated', 'published']);
export const lineOut = z.object({
  id: z.string(), serviceId: z.string().nullable(), description: z.string(), pricing: pricingEnum, quantity: z.number(), unitPriceMinor: z.number().int(),
  taxRateBp: z.number().int(), appliesTo: z.array(unitKindEnum), fund: fundEnum, source: z.enum(['auto', 'manual']), note: z.string().nullable(), sortOrder: z.number().int(),
});
export const periodOut = z.object({
  id: z.string(), buildingId: z.string(), period: z.string(), status: periodStatusEnum, managementFeeMinor: z.number().int(), managementFeeTaxRateBp: z.number().int(),
  managementFeeAppliesTo: z.array(unitKindEnum), numberPrefix: z.string(), numberSuffix: z.string(), currency: z.string(),
  issuedAt: z.date().or(z.string()).nullable(), dueAt: z.date().or(z.string()).nullable(), generatedAt: z.date().or(z.string()).nullable(), publishedAt: z.date().or(z.string()).nullable(),
  warnings: z.array(z.record(z.unknown())), invoiceCount: z.number().int(), totalMinor: z.number().int(), createdAt: z.date().or(z.string()), updatedAt: z.date().or(z.string()),
});
export const periodDetailOut = periodOut.extend({ lines: z.array(lineOut) });
export const periodCreate = z.object({
  period: periodStr, managementFeeMinor: moneyMinor.optional(), managementFeeTaxRateId: z.string().uuid().nullable().optional(),
  managementFeeAppliesTo: z.array(unitKindEnum).max(5).transform(dedupe).optional(),
});
export const periodPatch = z.object({
  managementFeeMinor: moneyMinor.optional(), managementFeeTaxRateId: z.string().uuid().nullable().optional(),
  managementFeeAppliesTo: z.array(unitKindEnum).max(5).transform(dedupe).optional(),
  numberPrefix: z.string().max(20).optional(), numberSuffix: z.string().max(20).optional(),
});
export const lineCreate = z.object({
  serviceId: z.string().uuid().optional(), description: z.string().min(1).max(300).optional(), pricing: pricingEnum.optional(),
  quantity: z.number().positive().max(10_000).optional(), unitPriceMinor: moneyMinor.optional(), taxRateId: z.string().uuid().nullable().optional(),
  appliesTo: z.array(unitKindEnum).max(5).transform(dedupe).optional(), fund: fundEnum.optional(), note: nullableStr(500),
}).refine((v) => v.serviceId || (v.description && v.pricing && v.unitPriceMinor !== undefined), { message: 'description, pricing and unitPriceMinor are required without serviceId' })
  .refine((v) => v.unitPriceMinor === undefined || (v.unitPriceMinor * (v.quantity ?? 1)) <= 1_000_000_000_000, { message: 'line total exceeds the supported maximum', path: ['unitPriceMinor'] });
export const linePatch = z.object({
  description: z.string().min(1).max(300).optional(), pricing: pricingEnum.optional(), quantity: z.number().positive().max(10_000).optional(),
  unitPriceMinor: moneyMinor.optional(), taxRateId: z.string().uuid().nullable().optional(), appliesTo: z.array(unitKindEnum).max(5).transform(dedupe).optional(),
  fund: fundEnum.optional(), note: z.string().max(500).optional(),
}).refine((v) => v.unitPriceMinor === undefined || v.quantity === undefined || v.unitPriceMinor * v.quantity <= 1_000_000_000_000, { message: 'line total exceeds the supported maximum', path: ['unitPriceMinor'] });
export const periodParam = z.object({ buildingId: z.string().uuid(), id: z.string().uuid() });
export const lineParam = periodParam.extend({ lineId: z.string().uuid() });
export type PeriodCreate = z.infer<typeof periodCreate>;
export type PeriodPatch = z.infer<typeof periodPatch>;
export type LineCreate = z.infer<typeof lineCreate>;
export type LinePatch = z.infer<typeof linePatch>;
