import { z } from 'zod';
import { pageQuery } from '../common.js';

export const legalEventKindEnum = z.enum([
  'invoice_published', 'reminder_sent', 'assembly_invited', 'assembly_held',
  'annual_report_issued', 'handover_report_issued', 'fund_statement_available', 'extraordinary_cost_distributed',
]);

export const legalEventOut = z.object({
  id: z.string(), buildingId: z.string(), kind: legalEventKindEnum,
  refType: z.string(), refId: z.string().nullable(),
  occurredAt: z.date().or(z.string()), dueAt: z.date().or(z.string()).nullable(),
  evidence: z.record(z.unknown()), createdBy: z.string().nullable(), createdAt: z.date().or(z.string()),
});
export const legalEventListOut = z.object({ rows: z.array(legalEventOut), total: z.number().int() });
export const legalEventQuery = pageQuery;
