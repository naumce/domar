import { z } from 'zod';
import { dateOnly } from '../contracts/schema.js';
import { documentOut } from '../documents/schema.js';

export const reportFundEnum = z.enum(['regular', 'reserve']);
export const reportKindEnum = z.enum(['annual', 'handover']);
const dt = () => z.date().or(z.string());

/** Plan addendum 3: one flat map of every scalar the template prints. */
export const fieldsOut = z.record(z.union([z.string(), z.number()]));

export const fundSummaryOut = z.object({
  fund: reportFundEnum,
  openingMinor: z.number().int(), inflowMinor: z.number().int(), outflowMinor: z.number().int(),
  /** Gross less what the reversals took back: what the fund really took in and really spent. */
  netInflowMinor: z.number().int(), netOutflowMinor: z.number().int(),
  closingMinor: z.number().int(),
  movements: z.array(z.object({
    kind: z.string(), refType: z.string(),
    inflowMinor: z.number().int(), outflowMinor: z.number().int(), netMinor: z.number().int(),
  })),
});
export const reportExpenseOut = z.object({
  id: z.string(), fund: reportFundEnum, description: z.string(), supplier: z.string(),
  amountMinor: z.number().int(), paidAt: z.string(),
});
export const reportOwnerOut = z.object({
  contactId: z.string(), name: z.string(), unitLabels: z.array(z.string()),
  /** False for somebody who owned during the window but owns nothing in the building at its end. */
  current: z.boolean(),
  billedMinor: z.number().int(), collectedMinor: z.number().int(), balanceMinor: z.number().int(),
});
export const debtorOut = z.object({ contactId: z.string(), name: z.string(), unitLabels: z.array(z.string()), balanceMinor: z.number().int() });

export const annualDataOut = z.object({
  fields: fieldsOut,
  funds: z.array(fundSummaryOut),
  expenses: z.array(reportExpenseOut),
  expensesBySupplier: z.array(z.object({ supplier: z.string(), count: z.number().int(), amountMinor: z.number().int() })),
  works: z.array(reportExpenseOut),
  owners: z.array(reportOwnerOut),
  debtors: z.array(debtorOut),
  assemblies: z.array(z.object({ heldAt: z.string(), decisionCount: z.number().int() })),
});

const reportYear = z.number().int().min(2000).max(2100);
export const annualQuery = z.object({ year: z.coerce.number().int().min(2000).max(2100) });
export const annualIssueBody = z.object({ year: reportYear });

/** One filed report: the legal event, joined to the document it points at. */
export const reportRowOut = z.object({
  eventId: z.string(), kind: reportKindEnum, occurredAt: dt(),
  documentId: z.string().nullable(), exportDocumentId: z.string().nullable(),
  title: z.string(), fileName: z.string(), sizeBytes: z.number().int(),
  evidence: z.record(z.unknown()),
});
export const reportListOut = z.object({ rows: z.array(reportRowOut), documents: z.array(documentOut) });
export const reportIssueOut = z.object({
  document: documentOut,
  /** The data export of a handover; null for an annual report (plan addendum 11). */
  exportDocumentId: z.string().nullable(),
  eventId: z.string(),
  year: z.number().int(),
  fields: fieldsOut,
});

/** The widest bank balance anybody can type, in minor units, shared by the body and the preview query. */
const BANK_MINOR = 1_000_000_000_000;
export const bankBalancesIn = z.object({
  regularMinor: z.number().int().min(-BANK_MINOR).max(BANK_MINOR),
  reserveMinor: z.number().int().min(-BANK_MINOR).max(BANK_MINOR),
});
/** `dateOnly` is a shape, not a calendar: 2026-02-31 matches it and is not a day anybody handed over on. */
export const asOfDate = dateOnly.refine((v) => new Date(`${v}T00:00:00.000Z`).toISOString().slice(0, 10) === v, 'not a calendar date');
export const openItemOut = z.object({
  invoiceId: z.string(), number: z.string().nullable(), contactId: z.string(), ownerName: z.string(),
  period: z.string(), dueAt: z.string().nullable(),
  totalMinor: z.number().int(), paidMinor: z.number().int(), outstandingMinor: z.number().int(),
});
export const reconciliationOut = z.object({
  fund: reportFundEnum, ledgerMinor: z.number().int(), bankMinor: z.number().int(), differenceMinor: z.number().int(),
});
export const handoverDataOut = z.object({
  fields: fieldsOut,
  annual: annualDataOut,
  owners: z.array(reportOwnerOut),
  openItems: z.array(openItemOut),
  reconciliation: z.array(reconciliationOut),
});
/** Both bank numbers or neither: one of them alone would print a difference that means nothing. */
export const handoverQuery = z.object({
  asOf: asOfDate,
  regularMinor: z.coerce.number().int().min(-BANK_MINOR).max(BANK_MINOR).optional(),
  reserveMinor: z.coerce.number().int().min(-BANK_MINOR).max(BANK_MINOR).optional(),
}).refine((v) => (v.regularMinor === undefined) === (v.reserveMinor === undefined), {
  message: 'give both bank balances or neither', path: ['reserveMinor'],
});
export const handoverIssueBody = z.object({
  asOf: asOfDate,
  bankBalances: bankBalancesIn,
  note: z.string().max(2000).nullable().optional(),
});
export type HandoverIssueBody = z.infer<typeof handoverIssueBody>;
