import { ACCOUNT_SLOTS } from '@domar/domain';
import { z } from 'zod';
import { periodStr } from '../common.js';
import { dateOnly as dateOnlyShape } from '../contracts/schema.js';

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

// `dateOnlyShape` bounds the month/day digits (01-12, 01-31) but not days-per-month, so `2026-02-30`
// still matches it; the round-trip through `Date` is what rejects a date that doesn't exist (fix
// round 1, item 5) — same check `reports/schema.ts`'s `asOfDate` already uses for the same reason.
const dateOnly = dateOnlyShape.refine(
  (v) => new Date(`${v}T00:00:00.000Z`).toISOString().slice(0, 10) === v,
  'not a calendar date',
);

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

export const accountingExportBody = z.object({
  from: dateOnly, to: dateOnly, buildingId: z.string().uuid().optional(),
});
export const accountingExportOut = z.object({
  documentId: z.string(), fileName: z.string(), entryCount: z.number(), adjustmentCount: z.number(),
  debitMinor: z.number(), creditMinor: z.number(),
});

export const accountingExportListRowOut = z.object({
  documentId: z.string(), fileName: z.string(), createdAt: z.date().or(z.string()),
  from: z.string(), to: z.string(), buildingId: z.string().nullable(),
  entryCount: z.number(), adjustmentCount: z.number(), debitMinor: z.number(), creditMinor: z.number(),
  sizeBytes: z.number(),
});
export const accountingExportListOut = z.object({ rows: z.array(accountingExportListRowOut) });

export const accountingPeriodParam = z.object({ period: periodStr });
export const accountingPeriodOut = z.object({
  id: z.string(), period: z.string(), closedAt: z.date().or(z.string()), closedBy: z.string().nullable(),
  closedByName: z.string().nullable(),
  debitTotalMinor: z.number(), creditTotalMinor: z.number(), entryCount: z.number(),
});
export const accountingPeriodListOut = z.object({ rows: z.array(accountingPeriodOut) });
