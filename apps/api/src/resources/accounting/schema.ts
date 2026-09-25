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

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export const accountingWindowQuery = z.object({
  from: dateOnly,
  to: dateOnly,
  buildingId: z.string().uuid().optional(),
});

export const trialBalanceRowOut = z.object({
  code: z.string(), name: z.string(), debitMinor: z.number(), creditMinor: z.number(), differenceMinor: z.number(),
});
export const accountingPreviewOut = z.object({
  from: z.string(), to: z.string(), buildingName: z.string().nullable(),
  trialBalance: z.array(trialBalanceRowOut),
  totals: z.object({ debitMinor: z.number(), creditMinor: z.number(), entryCount: z.number(), lineCount: z.number() }),
  adjustmentCount: z.number(),
  closedPeriods: z.array(z.string()),
  balanced: z.boolean(),
});
