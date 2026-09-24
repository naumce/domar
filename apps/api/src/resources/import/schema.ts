import { z } from 'zod';
import { unitKindEnum } from '../common.js';

export const importUnitsBody = z.object({
  content: z.string().min(1).max(3_000_000),
  mode: z.enum(['fail', 'skip']).default('fail'),
  dryRun: z.boolean().default(false),
  force: z.boolean().default(false),
});
export const importRowOut = z.object({
  line: z.number().int(), label: z.string(), floor: z.string().nullable(), kind: unitKindEnum,
  areaM2: z.number().nullable(), ownershipShare: z.number().nullable(),
  ownerFirstName: z.string().nullable(), ownerLastName: z.string().nullable(),
  ownerEmail: z.string().nullable(), ownerPhone: z.string().nullable(),
  openingBalanceMinor: z.number().int(),
});
export const importResultOut = z.object({
  dryRun: z.boolean(),
  hasPublishedPeriod: z.boolean(),
  /** What stops this file from being committed as it stands; a preview reports it, a commit throws it. */
  blocked: z.enum(['period_published']).nullable(),
  rows: z.array(importRowOut),
  errors: z.array(z.object({ line: z.number().int(), message: z.string() })),
  counts: z.object({
    units: z.number().int(), newContacts: z.number().int(), existingContacts: z.number().int(),
    openingBalances: z.number().int(), conflicts: z.number().int(),
  }),
  conflicts: z.array(z.string()),
});
export type ImportUnitsBody = z.infer<typeof importUnitsBody>;
