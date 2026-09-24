import { z } from 'zod';

export const complianceStatusEnum = z.enum(['ok', 'due', 'overdue', 'n/a']);
export const complianceDutyKeyEnum = z.enum([
  'invoices', 'reminders', 'assembly', 'annual_report', 'fund_transparency', 'fund_accounts', 'handover', 'extraordinary_costs',
]);
const countsOut = z.object({ ok: z.number().int(), due: z.number().int(), overdue: z.number().int(), na: z.number().int() });
const buildingRef = z.object({ id: z.string(), name: z.string() });

export const complianceDutyOut = z.object({
  key: complianceDutyKeyEnum,
  article: z.string(),
  status: complianceStatusEnum,
  dueAt: z.string().nullable(),
  lastEvidenceAt: z.string().nullable(),
  /** Query string relative to `/app/buildings/<id>`. */
  howToFix: z.string(),
  count: z.number().int().nullable(),
  /** From the country pack, in the country's legal language (plan addendum 7). */
  label: z.string(),
  hint: z.string(),
  /** Signals that don't change `status` on their own (e.g. `late_invitation`). */
  flags: z.array(z.string()),
});

export const buildingComplianceOut = z.object({
  building: buildingRef, status: complianceStatusEnum, counts: countsOut,
  duties: z.array(complianceDutyOut), evaluatedAt: z.string(),
});

export const complianceOverviewOut = z.object({
  rows: z.array(z.object({
    building: buildingRef, status: complianceStatusEnum, counts: countsOut,
    duties: z.array(z.object({ key: complianceDutyKeyEnum, status: complianceStatusEnum })),
  })),
  counts: countsOut,
  evaluatedAt: z.string(),
});
