import { ACCOUNT_SLOTS } from '@domar/domain';
import { z } from 'zod';

export const accountSlotEnum = z.enum(ACCOUNT_SLOTS);
export const accountSlotParam = z.object({ slot: accountSlotEnum });

export const accountCodeOut = z.object({
  id: z.string(), slot: accountSlotEnum, code: z.string(), name: z.string(), isActive: z.boolean(),
  createdAt: z.date().or(z.string()), updatedAt: z.date().or(z.string()),
});
export const accountCodeListOut = z.object({ rows: z.array(accountCodeOut), missing: z.array(accountSlotEnum) });
export const accountCodePut = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  isActive: z.boolean().optional(),
});
export type AccountCodePut = z.infer<typeof accountCodePut>;
