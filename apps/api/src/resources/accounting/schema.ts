import { ACCOUNT_SLOTS } from '@domar/domain';
import { z } from 'zod';
import { periodStr } from '../common.js';

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

/**
 * The whole zip is built in memory (controller ruling, Task 5 review): nothing capped how long a
 * window could be, so a multi-year tenant-wide export on a large tenant could exhaust it. 366 days —
 * a full calendar year, leap included — is the largest grain the product already reasons in
 * (`yearWindow` in `@domar/domain` cuts the annual report the same way), so a legitimate close or
 * export never needs more than this without also needing to split by year regardless.
 */
export const MAX_WINDOW_DAYS = 366;

const withinSpanLimit = (v: { from: string; to: string }) =>
  new Date(`${v.to}T00:00:00Z`).getTime() - new Date(`${v.from}T00:00:00Z`).getTime() <= MAX_WINDOW_DAYS * 86_400_000;
const spanLimitIssue = { message: `The window must not exceed ${MAX_WINDOW_DAYS} days`, path: ['to'] };

export const accountingWindowQuery = z.object({
  from: dateOnly,
  to: dateOnly,
  buildingId: z.string().uuid().optional(),
}).refine(withinSpanLimit, spanLimitIssue);

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
}).refine(withinSpanLimit, spanLimitIssue);
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
