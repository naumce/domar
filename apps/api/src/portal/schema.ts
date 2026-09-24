import { z } from 'zod';
import { pageQuery } from '../resources/common.js';
import { invoiceDetailOut } from '../resources/invoices/schema.js';
import { paymentOut } from '../resources/payments/schema.js';
import { fundEnum } from '../resources/reserve-fund/schema.js';

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

/**
 * The owner's view of a payment: the manager's own bookkeeping fields — the free-text `note`, the
 * `voidReason` and the bank-statement line it was matched against — are not an owner's business and
 * are dropped from the wire, not merely left unrendered.
 */
export const portalPaymentOut = paymentOut.omit({ note: true, statementLineId: true, voidReason: true });
export const portalInvoiceDetailOut = invoiceDetailOut.extend({ payments: z.array(portalPaymentOut) });

export const portalContactQuery = z.object({ contactId: z.string().uuid() });
export const portalInvoiceListQuery = pageQuery.extend({ contactId: z.string().uuid() });
export const portalPaymentListQuery = pageQuery.extend({ contactId: z.string().uuid() });
export const portalStatementQuery = portalContactQuery.extend({ buildingId: z.string().uuid().optional() });

export const portalFundOut = z.object({
  building: z.object({ id: z.string(), name: z.string() }),
  regular: z.object({ balanceMinor: z.number().int(), billedMinor: z.number().int() }),
  reserve: z.object({ balanceMinor: z.number().int(), billedMinor: z.number().int() }),
  transactions: z.array(z.object({
    id: z.string(),
    kind: z.enum(['charge', 'payment', 'expense', 'adjustment', 'opening']),
    fund: fundEnum,
    amountMinor: z.number().int(),
    bookedAt: z.date().or(z.string()),
    description: z.string().nullable(),
  })),
  truncated: z.boolean(),
});
