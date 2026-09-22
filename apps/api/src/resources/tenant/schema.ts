import { z } from 'zod';
import { nullableStr } from '../common.js';

export const tenantOut = z.object({
  id: z.string(), slug: z.string(), name: z.string(), countryCode: z.string(), currency: z.string(), locale: z.string(), timezone: z.string(),
  companyNumber: z.string().nullable(), vatNumber: z.string().nullable(), address: z.string().nullable(), phone: z.string().nullable(),
  email: z.string().nullable(), bankName: z.string().nullable(), bankAccount: z.string().nullable(),
});
export const tenantPatch = z.object({
  name: z.string().min(1).max(200).optional(), timezone: z.string().max(64).optional(),
  companyNumber: nullableStr(50), vatNumber: nullableStr(50), address: nullableStr(500), phone: nullableStr(50),
  email: z.string().email().nullable().optional(), bankName: nullableStr(200), bankAccount: nullableStr(50),
}).strict();
export type TenantPatch = z.infer<typeof tenantPatch>;
