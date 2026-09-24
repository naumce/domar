import { z } from 'zod';

export const reminderReasonEnum = z.enum(['consecutive', 'total']);
export const reminderChannelEnum = z.enum(['email', 'letter']);
export const reminderStatusEnum = z.enum(['pending', 'sent', 'failed', 'printed']);

export const reminderOut = z.object({
  id: z.string(), buildingId: z.string(), contactId: z.string(),
  reason: reminderReasonEnum, invoiceIds: z.array(z.string()), invoiceNumbers: z.array(z.string()),
  totalOutstandingMinor: z.number().int(), channel: reminderChannelEnum, status: reminderStatusEnum,
  sentAt: z.date().or(z.string()).nullable(), error: z.string().nullable(),
  contact: z.object({ id: z.string(), firstName: z.string(), lastName: z.string(), email: z.string().nullable() }),
  createdAt: z.date().or(z.string()),
});

export const reminderListOut = z.object({ rows: z.array(reminderOut) });
export const jobResultOut = z.object({ tenants: z.number().int(), buildings: z.number().int(), reminders: z.number().int() });
