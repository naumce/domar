import { z } from 'zod';
import { boolQuery, nullableStr } from '../common.js';

export const supplierOut = z.object({
  id: z.string(), name: z.string(), companyNumber: z.string().nullable(), vatNumber: z.string().nullable(),
  email: z.string().nullable(), phone: z.string().nullable(), iban: z.string().nullable(), notes: z.string().nullable(),
  isActive: z.boolean(), createdAt: z.date().or(z.string()), updatedAt: z.date().or(z.string()),
});
export const supplierListOut = z.object({ rows: z.array(supplierOut) });
export const supplierListQuery = z.object({ includeInactive: boolQuery.optional() });
export const supplierCreate = z.object({
  name: z.string().min(1).max(200), companyNumber: nullableStr(50), vatNumber: nullableStr(50),
  email: z.string().email().max(200).nullable().optional(), phone: nullableStr(50), iban: nullableStr(50),
  notes: nullableStr(2000), isActive: z.boolean().optional(),
});
export const supplierPatch = supplierCreate.partial().strict().refine((v) => Object.keys(v).length > 0, 'empty patch');
export type SupplierCreate = z.infer<typeof supplierCreate>;
export type SupplierPatch = z.infer<typeof supplierPatch>;
