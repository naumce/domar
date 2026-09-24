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
/** Only the statuses the portal shows at all, so the filter cannot ask for drafts. */
export const portalInvoiceStatusEnum = z.enum(['published', 'partially_paid', 'paid', 'cancelled']);
export const portalInvoiceListQuery = pageQuery.extend({ contactId: z.string().uuid(), status: portalInvoiceStatusEnum.optional() });
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

export const portalDocumentOut = z.object({
  id: z.string(), buildingId: z.string(), kind: z.enum(['minutes', 'report']), title: z.string(),
  fileName: z.string(), mime: z.string(), sizeBytes: z.number().int(), createdAt: z.date().or(z.string()),
});
export const portalDocumentListOut = z.object({ rows: z.array(portalDocumentOut) });
export const portalDocumentListQuery = portalContactQuery.extend({ buildingId: z.string().uuid() });

const voteChoice = z.enum(['for', 'against', 'abstain']);

export const portalAssemblyRowOut = z.object({
  id: z.string(), buildingId: z.string(), buildingName: z.string(), scheduledAt: z.date().or(z.string()),
  location: z.string(), status: z.enum(['invited', 'held']), heldAt: z.date().or(z.string()).nullable(),
  minutesDocumentId: z.string().nullable(), agendaCount: z.number().int(),
});
export const portalAssemblyListOut = z.object({ rows: z.array(portalAssemblyRowOut) });
export const portalAssemblyDecisionOut = z.object({
  id: z.string(), title: z.string(), text: z.string().nullable(), myChoice: voteChoice.nullable(),
  forWeight: z.number().int().nullable(), againstWeight: z.number().int().nullable(), abstainWeight: z.number().int().nullable(),
  presentWeight: z.number().int().nullable(), basisTotal: z.number().int().nullable(), quorumReached: z.boolean().nullable(),
  result: z.enum(['pending', 'passed', 'rejected', 'no_quorum']).nullable(),
});
export const portalAssemblyOut = portalAssemblyRowOut.omit({ agendaCount: true }).extend({
  agenda: z.array(z.object({ id: z.string(), title: z.string(), text: z.string() })),
  votingOpen: z.boolean(),
  decisions: z.array(portalAssemblyDecisionOut),
});
/** `contactId` travels in the body here, not the query: this is the portal's one POST. */
export const portalVoteBody = z.object({ contactId: z.string().uuid(), choice: voteChoice });
export const portalAssemblyDecisionParam = z.object({ id: z.string().uuid(), decisionId: z.string().uuid() });
