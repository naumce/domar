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
}

export interface CountryPack {
  code: CountryCode;
  currency: string;
  locale: string;
  defaultTaxRates: TaxRateDefault[];
  labels: CountryLabels;
  invoiceLayout: InvoiceLayoutRules;
  reminderRules: ReminderRules;
  statementParsers: StatementParser[];
  /** Format minor units for display, e.g. 123456 → "1.234,56 ден." */
  formatMoney(minor: number): string;
  /** Parse user or bank text like "1.234,56" or "1234.56" into minor units. Throws on garbage. */
  parseAmountToMinor(text: string): number;
}
