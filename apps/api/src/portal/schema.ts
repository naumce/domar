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

const portalPassword = z.string().min(10).max(200);

export const portalRegisterBody = z.object({ code: z.string().min(4).max(32), email: z.string().email().max(200), password: portalPassword });
export const portalLoginBody = z.object({ email: z.string().email().max(200), password: z.string().max(200) });
export const portalLinkBody = z.object({ code: z.string().min(4).max(32) });
export const portalChangePasswordBody = z.object({ currentPassword: z.string().max(200), newPassword: portalPassword });

export const portalLinkOut = z.object({
  tenantId: z.string(), tenantName: z.string(), contactId: z.string(), contactName: z.string(),
  buildings: z.array(z.object({ id: z.string(), name: z.string() })),
});
export const portalMeOut = z.object({
  account: z.object({ id: z.string(), email: z.string() }),
  links: z.array(portalLinkOut),
});
