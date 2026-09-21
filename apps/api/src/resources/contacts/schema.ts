import { z } from 'zod';
import { nullableStr, pageQuery } from '../common.js';

export const contactOut = z.object({
  id: z.string(), kind: z.enum(['person', 'company']), firstName: z.string(), lastName: z.string(),
  companyNumber: z.string().nullable(), vatNumber: z.string().nullable(), email: z.string().nullable(),
  phone: z.string().nullable(), address: z.string().nullable(), notes: z.string().nullable(),
  createdAt: z.date().or(z.string()), updatedAt: z.date().or(z.string()),
});
export const contactCreate = z.object({
  kind: z.enum(['person', 'company']).default('person'),
  firstName: z.string().max(100).default(''),
  lastName: z.string().min(1).max(200),
  companyNumber: nullableStr(50), vatNumber: nullableStr(50),
  email: z.string().email().nullable().optional(), phone: nullableStr(50), address: nullableStr(500), notes: nullableStr(5000),
}).refine((c) => c.kind !== 'company' || !!c.companyNumber, { message: 'companyNumber is required for companies', path: ['companyNumber'] });
export const contactPatch = z.object({
  kind: z.enum(['person', 'company']).optional(), firstName: z.string().max(100).optional(), lastName: z.string().min(1).max(200).optional(),
  companyNumber: nullableStr(50), vatNumber: nullableStr(50), email: z.string().email().nullable().optional(),
  phone: nullableStr(50), address: nullableStr(500), notes: nullableStr(5000),
});
export const contactListQuery = pageQuery.extend({ search: z.string().max(100).optional() });
export type ContactCreate = z.infer<typeof contactCreate>;
export type ContactPatch = z.infer<typeof contactPatch>;
