import { z } from 'zod';
import { nullableStr } from '../common.js';
import { fundEnum } from '../reserve-fund/schema.js';

const signedMoney = z.number().int().min(-1_000_000_000_000).max(1_000_000_000_000);

export const openingBalanceRow = z.object({
  contactId: z.string().uuid(),
  fund: fundEnum.default('regular'),
  amountMinor: signedMoney.refine((v) => v !== 0, { message: 'amountMinor cannot be zero' }),
  bookedAt: z.string().datetime().optional(),
  note: nullableStr(500),
});
export const openingBalanceCreate = z.object({
  rows: z.array(openingBalanceRow).min(1).max(500),
  force: z.boolean().default(false),
});
export const openingPostingOut = z.object({
  id: z.string(), contactId: z.string(), fund: fundEnum, amountMinor: z.number().int(),
  bookedAt: z.date().or(z.string()), note: z.string().nullable(),
});
export const openingBalanceCreated = z.object({ created: z.number().int(), postings: z.array(openingPostingOut) });
export const ownerBalanceOut = z.object({
  contactId: z.string(), firstName: z.string(), lastName: z.string(),
  regularMinor: z.number().int(), reserveMinor: z.number().int(), balanceMinor: z.number().int(), openingMinor: z.number().int(),
});
export const ownerBalanceList = z.object({ rows: z.array(ownerBalanceOut), hasPublishedPeriod: z.boolean() });

export type OpeningBalanceRow = z.infer<typeof openingBalanceRow>;
export type OpeningBalanceCreate = z.infer<typeof openingBalanceCreate>;
