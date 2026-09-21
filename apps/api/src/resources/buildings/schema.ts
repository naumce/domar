import { z } from 'zod';
import { nullableStr } from '../common.js';

export const shareBasisEnum = z.enum(['area', 'equal', 'custom']);
export const buildingOut = z.object({
  id: z.string(), name: z.string(), address: z.string(), city: z.string(), postalCode: z.string(), countryCode: z.string(),
  representativeContactId: z.string().nullable(), regularFundAccount: z.string().nullable(), reserveFundAccount: z.string().nullable(),
  shareBasis: shareBasisEnum, createdAt: z.date().or(z.string()), updatedAt: z.date().or(z.string()),
});
export const buildingListOut = buildingOut.extend({ unitCount: z.number().int() });
export const buildingCreate = z.object({
  name: z.string().min(1).max(200), address: z.string().max(300).default(''), city: z.string().max(100).default(''), postalCode: z.string().max(20).default(''),
  countryCode: z.string().length(2).optional(), representativeContactId: z.string().uuid().nullable().optional(),
  regularFundAccount: nullableStr(50), reserveFundAccount: nullableStr(50), shareBasis: shareBasisEnum.optional(),
});
export const buildingPatch = buildingCreate.partial();
export type BuildingCreate = z.infer<typeof buildingCreate>;
export type BuildingPatch = z.infer<typeof buildingPatch>;
