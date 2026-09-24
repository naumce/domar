import { z } from 'zod';

export const portalInviteOut = z.object({
  code: z.string(),
  expiresAt: z.date().or(z.string()),
  emailed: z.boolean(),
});

export const portalStatusOut = z.object({
  status: z.enum(['none', 'invited', 'linked']),
  expiresAt: z.date().or(z.string()).optional(),
  linkedAt: z.date().or(z.string()).optional(),
});
