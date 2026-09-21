import { z } from 'zod';
import { unitKindEnum } from '../common.js';

export { unitKindEnum };
const ownerOut = z.object({ id: z.string(), firstName: z.string(), lastName: z.string() }).nullable();
export const unitOut = z.object({
  id: z.string(), buildingId: z.string(), label: z.string(), floor: z.string().nullable(), kind: unitKindEnum,
  areaM2: z.number().nullable(), ownershipShare: z.number().nullable(), ownerContactId: z.string().nullable(), attachedToUnitId: z.string().nullable(),
  owner: ownerOut, createdAt: z.date().or(z.string()), updatedAt: z.date().or(z.string()),
});
export const unitCreate = z.object({
  label: z.string().min(1).max(50), floor: z.string().max(20).nullable().optional(), kind: unitKindEnum,
  areaM2: z.number().positive().max(99_999_999).nullable().optional(), ownershipShare: z.number().min(0).max(1).nullable().optional(),
  ownerContactId: z.string().uuid().nullable().optional(), attachedToUnitId: z.string().uuid().nullable().optional(),
});
export const unitPatch = unitCreate.partial();
export const buildingParam = z.object({ buildingId: z.string().uuid() });
export const buildingUnitParam = buildingParam.extend({ id: z.string().uuid() });
export type UnitCreate = z.infer<typeof unitCreate>;
export type UnitPatch = z.infer<typeof unitPatch>;
