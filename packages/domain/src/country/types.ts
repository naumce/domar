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

/** The eight legal duties `compliance/evaluate.ts` evaluates, in their fixed report order. */
export type ComplianceDutyKey =
  | 'invoices' | 'reminders' | 'assembly' | 'annual_report'
  | 'fund_transparency' | 'fund_accounts' | 'handover' | 'extraordinary_costs';

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

/** Art. 31 and Art. 30: the fixed text the two report documents print. */
export interface ReportLabels {
  annualTitle: string;
  annualLegal: string;
  handoverTitle: string;
  handoverLegal: string;
  /** What an expense with neither a supplier row nor a supplier text is listed as. */
  noSupplier: string;
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
  /** Art. 37: the opening sentence of the assembly invitation, above the agenda. */
  assemblyInvitationIntro: string;
  /** Art. 37: the legal sentence printed on the invitation and repeated in the minutes. */
  assemblyLegal: string;
  /** Art. 31 and Art. 30: what the annual and the handover report print. */
  reports: ReportLabels;
  /** One entry per `ComplianceDutyKey`. */
  compliance: Record<ComplianceDutyKey, ComplianceLabel>;
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
