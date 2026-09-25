import { NOTIFICATION_KINDS } from '@domar/domain';
import { z } from 'zod';

export const notificationKindEnum = z.enum(NOTIFICATION_KINDS);
export const notificationRowOut = z.object({
  id: z.string(),
  kind: notificationKindEnum,
  title: z.string(),
  body: z.string(),
  link: z.string(),
  createdAt: z.date().or(z.string()),
  readAt: z.date().or(z.string()).nullable(),
});
export const notificationListOut = z.object({ rows: z.array(notificationRowOut), unread: z.number().int() });
