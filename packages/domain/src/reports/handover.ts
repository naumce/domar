import { civilDayStart, localDayStart } from '../period.js';
import {
  buildAnnualReport,
  type AnnualReportData, type AnnualReportInput, type ReportFund, type ReportOwner, type ReportWindow,
} from './annual.js';
import { byCode, byName } from './order.js';

const DAY_MS = 86_400_000;

/**
 * Art. 30: the civil year up to and including `asOf` (plan addendum 9). The exclusive end is local
 * midnight of the day *after* `asOf`, resolved through the zone a second time so the last day of the
 * window is 23 or 25 hours long across a DST change rather than a flat 24.
 */
export function asOfWindow(asOf: string, timeZone: string): ReportWindow {
  const year = Number(asOf.slice(0, 4));
  const nextDay = new Date(Date.parse(`${asOf}T12:00:00.000Z`) + DAY_MS);
  return { from: civilDayStart(`${year}-01-01`, timeZone), to: localDayStart(nextDay, timeZone) };
}

/** A published invoice still owed on the handover date. */
export interface OpenItem {
  invoiceId: string;
  number: string | null;
  contactId: string;
  ownerName: string;
  period: string;
  dueAt: string | null;
  totalMinor: number;
  paidMinor: number;
  outstandingMinor: number;
}

/** The manager's reading of the two bank statements; input, never derived (plan addendum 10). */
export interface BankBalances { regularMinor: number; reserveMinor: number; asOf: string }

export interface HandoverReportInput extends AnnualReportInput {
  /** `YYYY-MM-DD`, the day the mandate ends. */
  asOf: string;
  /** `building_contracts.ends_on` of the newest management contract, or null when there is none. */
  contractEndsOn: string | null;
  openItems: OpenItem[];
  bankBalances: BankBalances;
  note: string | null;
}

export interface FundReconciliation { fund: ReportFund; ledgerMinor: number; bankMinor: number; differenceMinor: number }

export interface HandoverReportData {
  fields: Record<string, string | number>;
  annual: AnnualReportData;
  /** Every owner with what they were billed, what they paid and where they stand — not only debtors. */
  owners: ReportOwner[];
  openItems: OpenItem[];
  reconciliation: FundReconciliation[];
}

/**
 * Art. 30. The annual arithmetic of the year so far, plus the three things a handover adds: every
 * owner's balance, every unpaid invoice, and the ledger measured against the bank. The difference is
 * printed, never corrected and never suppressed (plan addendum 10).
 */
export function buildHandoverReport(input: HandoverReportInput): HandoverReportData {
  const annual = buildAnnualReport(input);
  const openItems = input.openItems
    .map((i) => ({ ...i }))
    .sort((a, b) => b.outstandingMinor - a.outstandingMinor || byName(a.ownerName, b.ownerName) || byCode(a.invoiceId, b.invoiceId));
  const bank: Record<ReportFund, number> = { regular: input.bankBalances.regularMinor, reserve: input.bankBalances.reserveMinor };
  const reconciliation: FundReconciliation[] = annual.funds.map((f) => ({
    fund: f.fund, ledgerMinor: f.closingMinor, bankMinor: bank[f.fund], differenceMinor: bank[f.fund] - f.closingMinor,
  }));
  return {
    fields: {
      ...annual.fields,
      asOf: input.asOf,
      contractEndsOn: input.contractEndsOn ?? '',
      note: input.note ?? '',
      bankAsOf: input.bankBalances.asOf,
      bankRegularMinor: bank.regular,
      bankReserveMinor: bank.reserve,
      regularDifferenceMinor: reconciliation[0]!.differenceMinor,
      reserveDifferenceMinor: reconciliation[1]!.differenceMinor,
      openItemsCount: openItems.length,
      openItemsMinor: openItems.reduce((s, i) => s + i.outstandingMinor, 0),
    },
    annual,
    owners: annual.owners,
    openItems,
    reconciliation,
  };
}
