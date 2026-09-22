import { z } from 'zod';

const dt = () => z.date().or(z.string());
export const importBody = z.object({ filename: z.string().min(1).max(200), content: z.string().min(1), autoConfirm: z.boolean().optional() });
export const suggestedInvoiceOut = z.object({ id: z.string(), number: z.string().nullable(), contactLastName: z.string(), outstandingMinor: z.number().int() }).nullable();
export const lineOut = z.object({
  id: z.string(), statementId: z.string(), lineNo: z.number().int(), bookedAt: dt(), amountMinor: z.number().int(), counterparty: z.string().nullable(), reference: z.string().nullable(),
  matchStatus: z.enum(['unmatched', 'suggested', 'matched', 'ignored']), confidence: z.string().nullable(), suggestedInvoice: suggestedInvoiceOut,
  payment: z.object({ id: z.string(), amountMinor: z.number().int(), status: z.enum(['completed', 'voided']) }).nullable(),
});
export const statementOut = z.object({
  id: z.string(), buildingId: z.string(), filename: z.string(), format: z.string(), accountNumber: z.string().nullable(),
  lineCount: z.number().int(), matchedCount: z.number().int(), skippedCount: z.number().int(), importedAt: dt(),
});
export const statementDetailOut = statementOut.extend({ lines: z.array(lineOut), warnings: z.array(z.string()).optional() });
export const confirmBody = z.object({ invoiceId: z.string().uuid() });
export type ImportBody = z.infer<typeof importBody>;
