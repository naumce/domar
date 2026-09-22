import { z } from 'zod';
import { nullableStr, pageQuery } from '../common.js';

export const paymentMethodEnum = z.enum(['cash', 'bank_transfer', 'card', 'cheque', 'other']);
export const paymentStatusEnum = z.enum(['completed', 'voided']);
const dt = () => z.date().or(z.string());
export const paymentCreate = z.object({
  amountMinor: z.number().int().min(1).max(1_000_000_000_000), method: paymentMethodEnum, paidAt: z.string().datetime(),
  reference: nullableStr(200), note: nullableStr(1000),
});
export const onAccountCreate = paymentCreate.extend({ contactId: z.string().uuid() });
export const voidBody = z.object({ reason: z.string().min(1).max(500) });
export const paymentOut = z.object({
  id: z.string(), buildingId: z.string(), invoiceId: z.string().nullable(), contactId: z.string(), amountMinor: z.number().int(), method: paymentMethodEnum,
  paidAt: dt(), reference: z.string().nullable(), note: z.string().nullable(), statementLineId: z.string().nullable(), status: paymentStatusEnum,
  voidReason: z.string().nullable(), voidedAt: dt().nullable(), createdAt: dt(),
  contact: z.object({ id: z.string(), firstName: z.string(), lastName: z.string() }), invoice: z.object({ id: z.string(), number: z.string().nullable() }).nullable(), building: z.object({ id: z.string(), name: z.string() }),
});
export const invoiceStatusOut = z.object({ id: z.string(), status: z.enum(['draft', 'published', 'partially_paid', 'paid', 'cancelled']), paidMinor: z.number().int(), outstandingMinor: z.number().int() });
export const recordOut = z.object({ payment: paymentOut, invoice: invoiceStatusOut.nullable() });
export const paymentListQuery = pageQuery.extend({
  buildingId: z.string().uuid().optional(), contactId: z.string().uuid().optional(), invoiceId: z.string().uuid().optional(), method: paymentMethodEnum.optional(),
  status: paymentStatusEnum.optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional(), search: z.string().max(100).optional(),
});
export const summaryOut = z.object({ totalMinor: z.number().int(), completedCount: z.number().int(), voidedCount: z.number().int(), byMethod: z.array(z.object({ method: paymentMethodEnum, totalMinor: z.number().int() })) });
export type PaymentCreate = z.infer<typeof paymentCreate>;
