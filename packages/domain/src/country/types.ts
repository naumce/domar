import type { StatementParser } from '../statements/types.js';

export type CountryCode = 'mk';

export interface TaxRateDefault {
  name: string;
  rateBp: number;
  isDefault: boolean;
}

/** Art. 33 Law on Housing (MK): what a monthly calculation must show. Other countries set their own. */
export interface InvoiceLayoutRules {
  showBuildingWideAmountPerLine: boolean;
  showManagementFeeLine: boolean;
  showReserveFundContribution: boolean;
  showReserveFundBuildingBalance: boolean;
  showPreviousBalance: boolean;
}

export type ReminderChannel = 'email' | 'sms' | 'letter';

/** Art. 28 Law on Housing (MK): when a reminder is due and whether it may be charged. */
export interface ReminderRules {
  consecutiveUnpaid: number;
  totalUnpaid: number;
  feeAllowed: boolean;
  channels: ReminderChannel[];
}

/** Art. 19/33, 28, 37, 31, 45(4), 42/45, 30, 47(5): the thresholds the compliance rules read. */
export interface ComplianceRules {
  /** Days a published period stays fresh before the next one is owed. */
  invoiceMaxAgeDays: number;
  /** Days after an owner crosses the Art. 28 threshold before the missing reminder is overdue. */
  reminderGraceDays: number;
  assemblyMaxAgeMonths: number;
  assemblyInvitationMinDays: number;
  annualReportMaxAgeMonths: number;
  /** Art. 30: days after the management contract ends in which the handover is still timely. */
  handoverDays: number;
  /** Generic grace after a day-grained deadline before `due` becomes `overdue`. */
  graceDays: number;
  /** Generic grace after a month-grained deadline before `due` becomes `overdue`. */
  graceMonths: number;
}

/** What the manager reads on a compliance card. The legal language of the pack, not the UI locale. */
export interface ComplianceLabel {
  title: string;
  hint: string;
}

/** Descriptions the billing engine synthesizes into invoices, in the country's language. */
export interface CountryLabels {
  reserveFund: string;
  managementFee: string;
  payment: string;
  paymentVoid: string;
  openingBalance: string;
  /** Opening sentence of the Art. 28 reminder document. */
  reminderIntro: string;
  /** The legal sentence of the reminder: the citation plus the statement that no fee is charged. */
  reminderLegal: string;
  /** One entry per `ComplianceDutyKey`; keyed loosely here so `compliance/evaluate.ts` owns the union. */
  compliance: Record<string, ComplianceLabel>;
}

export interface CountryPack {
  code: CountryCode;
  currency: string;
  locale: string;
  defaultTaxRates: TaxRateDefault[];
  labels: CountryLabels;
  invoiceLayout: InvoiceLayoutRules;
  reminderRules: ReminderRules;
  complianceRules: ComplianceRules;
  statementParsers: StatementParser[];
  /** Format minor units for display, e.g. 123456 → "1.234,56 ден." */
  formatMoney(minor: number): string;
  /** Parse user or bank text like "1.234,56" or "1234.56" into minor units. Throws on garbage. */
  parseAmountToMinor(text: string): number;
}
