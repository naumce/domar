import { z } from 'zod';

export const contractKindEnum = z.enum(['management', 'service', 'insurance', 'other']);
export const dateOnly = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'YYYY-MM-DD');

export const contractOut = z.object({
  id: z.string(), buildingId: z.string(), supplierId: z.string().nullable(), kind: contractKindEnum, title: z.string(),
  startsOn: z.string(), endsOn: z.string().nullable(), noticeDays: z.number().int(), amountMinor: z.number().int().nullable(),
  documentId: z.string().nullable(),
  supplier: z.object({ id: z.string(), name: z.string() }).nullable(),
  document: z.object({ id: z.string(), title: z.string(), fileName: z.string() }).nullable(),
  createdAt: z.date().or(z.string()), updatedAt: z.date().or(z.string()),
});
export const contractListOut = z.object({ rows: z.array(contractOut) });
export const contractCreate = z.object({
  kind: contractKindEnum, title: z.string().min(1).max(200), startsOn: dateOnly, endsOn: dateOnly.nullable().optional(),
  supplierId: z.string().uuid().nullable().optional(), documentId: z.string().uuid().nullable().optional(),
  noticeDays: z.number().int().min(0).max(365).optional(), amountMinor: z.number().int().min(0).max(1_000_000_000_000).nullable().optional(),
}).refine((v) => !v.endsOn || v.endsOn >= v.startsOn, { message: 'endsOn must not be before startsOn', path: ['endsOn'] })
  .refine((v) => !(v.kind === 'management' && v.supplierId), { message: "a management contract is the manager's own", path: ['supplierId'] });
export const contractPatch = z.object({
  kind: contractKindEnum.optional(), title: z.string().min(1).max(200).optional(), startsOn: dateOnly.optional(),
  endsOn: dateOnly.nullable().optional(), supplierId: z.string().uuid().nullable().optional(),
  documentId: z.string().uuid().nullable().optional(), noticeDays: z.number().int().min(0).max(365).optional(),
  amountMinor: z.number().int().min(0).max(1_000_000_000_000).nullable().optional(),
}).strict().refine((v) => Object.keys(v).length > 0, 'empty patch')
  .refine((v) => !(v.kind === 'management' && v.supplierId), { message: "a management contract is the manager's own", path: ['supplierId'] });
export const contractParam = z.object({ buildingId: z.string().uuid(), id: z.string().uuid() });
export type ContractCreate = z.infer<typeof contractCreate>;
export type ContractPatch = z.infer<typeof contractPatch>;
