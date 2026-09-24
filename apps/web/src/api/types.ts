export interface User { id: string; email: string; firstName: string; lastName: string; role: 'owner' | 'accountant' | 'technician' | 'readonly' }
export interface Tenant {
  id: string; slug: string; name: string; countryCode: string; currency: string; locale: string; timezone: string;
  companyNumber: string | null; vatNumber: string | null; address: string | null; phone: string | null; email: string | null; bankName: string | null; bankAccount: string | null;
}
export interface TaxRate { id: string; name: string; rateBp: number; isDefault: boolean; isActive: boolean }
export interface Contact { id: string; kind: 'person' | 'company'; firstName: string; lastName: string; companyNumber: string | null; vatNumber: string | null; email: string | null; phone: string | null; address: string | null; notes: string | null }
export interface Building { id: string; name: string; address: string; city: string; postalCode: string; countryCode: string; representativeContactId: string | null; regularFundAccount: string | null; reserveFundAccount: string | null; shareBasis: 'area' | 'equal' | 'custom'; unitCount?: number }
export type UnitKind = 'apartment' | 'commercial' | 'parking' | 'storage' | 'other';
export interface Unit { id: string; buildingId: string; label: string; floor: string | null; kind: UnitKind; areaM2: number | null; ownershipShare: number | null; ownerContactId: string | null; attachedToUnitId: string | null; owner: { id: string; firstName: string; lastName: string } | null }
export type PricingModel = 'fixed_per_unit' | 'per_m2' | 'shared_total';
export type Fund = 'regular' | 'reserve';
export interface Service { id: string; name: string; category: string | null; description: string | null; pricing: PricingModel; defaultPriceMinor: number; taxRateId: string | null; taxRateBp: number; appliesTo: UnitKind[]; recurring: boolean; isActive: boolean }
export interface BuildingService { id: string; buildingId: string; serviceId: string; priceMinor: number | null; pricing: PricingModel | null; frequency: 'monthly' | 'every_n_months'; intervalMonths: number; startsPeriod: string; endsPeriod: string | null; isActive: boolean; effectivePriceMinor: number; effectivePricing: PricingModel; service: { id: string; name: string; pricing: PricingModel; defaultPriceMinor: number; taxRateBp: number; appliesTo: UnitKind[]; isActive: boolean } }
export interface ReserveFundSetting { id: string; buildingId: string; basis: 'per_unit' | 'per_m2'; amountMinor: number; appliesTo: UnitKind[]; active: boolean }
export interface ReserveFundState { setting: ReserveFundSetting | null; balanceMinor: number; contributionsBilledMinor: number }
export interface Expense { id: string; buildingId: string; fund: Fund; description: string; supplierText: string | null; amountMinor: number; paidAt: string; voidedAt: string | null; voidReason: string | null; createdAt: string }
export interface FundTransaction { id: string; kind: 'charge' | 'payment' | 'expense' | 'adjustment' | 'opening'; fund: Fund; amountMinor: number; refType: string; refId: string | null; bookedAt: string; description: string | null }
export interface PeriodLine { id: string; serviceId: string | null; description: string; pricing: PricingModel; quantity: number; unitPriceMinor: number; taxRateBp: number; appliesTo: UnitKind[]; fund: Fund; source: 'auto' | 'manual'; note: string | null; sortOrder: number }
export interface Period { id: string; buildingId: string; period: string; status: 'open' | 'generated' | 'published'; managementFeeMinor: number; managementFeeTaxRateBp: number; managementFeeAppliesTo: UnitKind[]; numberPrefix: string; numberSuffix: string; currency: string; issuedAt: string | null; dueAt: string | null; generatedAt: string | null; publishedAt: string | null; warnings: Record<string, unknown>[]; invoiceCount: number; totalMinor: number; lines?: PeriodLine[] }
export type InvoiceStatus = 'draft' | 'published' | 'partially_paid' | 'paid' | 'cancelled';
export interface InvoiceLine { id: string; kind: 'service' | 'manual' | 'reserve_fund' | 'management_fee'; description: string; fund: Fund; unitId: string | null; unitLabel: string; buildingWideNetMinor: number; ownerNetMinor: number; taxRateBp: number; ownerTaxMinor: number; ownerGrossMinor: number; sortOrder: number }
export interface InvoiceRow { id: string; periodId: string; buildingId: string; contactId: string; number: string | null; status: InvoiceStatus; currency: string; unitIds: string[]; subtotalMinor: number; taxMinor: number; totalMinor: number; previousBalanceMinor: number; amountDueMinor: number; reserveFundBuildingBalanceMinor: number; paidMinor: number; outstandingMinor: number; issuedAt: string | null; dueAt: string | null; publishedAt: string | null; period: string; contact: { id: string; firstName: string; lastName: string }; building: { id: string; name: string }; createdAt: string }
export type Invoice = Omit<InvoiceRow, 'contact' | 'building'> & {
  contact: { id: string; kind: 'person' | 'company'; firstName: string; lastName: string; email: string | null; address: string | null; companyNumber: string | null; vatNumber: string | null };
  building: { id: string; name: string; address: string; city: string; postalCode: string; regularFundAccount: string | null; reserveFundAccount: string | null };
  lines: InvoiceLine[];
  payments: Payment[];
};
export type PaymentMethod = 'cash' | 'bank_transfer' | 'card' | 'cheque' | 'other';
export interface Payment { id: string; buildingId: string; invoiceId: string | null; contactId: string; amountMinor: number; method: PaymentMethod; paidAt: string; reference: string | null; note: string | null; statementLineId: string | null; status: 'completed' | 'voided'; voidReason: string | null; voidedAt: string | null; createdAt: string; contact: { id: string; firstName: string; lastName: string }; invoice: { id: string; number: string | null } | null; building: { id: string; name: string } }
export interface PaymentSummary { totalMinor: number; completedCount: number; voidedCount: number; byMethod: { method: PaymentMethod; totalMinor: number }[] }
export type MatchStatus = 'unmatched' | 'suggested' | 'matched' | 'ignored';
export interface BankStatement { id: string; buildingId: string; filename: string; format: string; accountNumber: string | null; lineCount: number; matchedCount: number; skippedCount: number; importedAt: string }
export interface StatementLine {
  id: string; statementId: string; lineNo: number; bookedAt: string; amountMinor: number; counterparty: string | null; reference: string | null;
  matchStatus: MatchStatus; confidence: string | null;
  suggestedInvoice: { id: string; number: string | null; contactLastName: string; outstandingMinor: number } | null;
  payment: { id: string; amountMinor: number; status: 'completed' | 'voided' } | null;
}
export interface DashboardStats { totalProperties: number; totalUnits: number; assignedOwners: number; billedThisMonthMinor: number; paidThisMonthMinor: number; unpaidInvoices: number; outstandingMinor: number }
export interface OwnerStatement {
  contact: { id: string; firstName: string; lastName: string };
  building: { id: string; name: string } | null;
  rows: { id: string; bookedAt: string; kind: FundTransaction['kind']; fund: Fund; amountMinor: number; balanceMinor: number; refType: string; refId: string | null; label: string }[];
  balanceMinor: number;
}
export interface OwnerOpeningBalance { contactId: string; firstName: string; lastName: string; regularMinor: number; reserveMinor: number; balanceMinor: number; openingMinor: number }
export interface OpeningBalanceList { rows: OwnerOpeningBalance[]; hasPublishedPeriod: boolean }
export interface UnitImportRow { line: number; label: string; floor: string | null; kind: UnitKind; areaM2: number | null; ownershipShare: number | null; ownerFirstName: string | null; ownerLastName: string | null; ownerEmail: string | null; ownerPhone: string | null; openingBalanceMinor: number }
export interface UnitImportResult { dryRun: boolean; rows: UnitImportRow[]; errors: { line: number; message: string }[]; counts: { units: number; newContacts: number; existingContacts: number; openingBalances: number; conflicts: number }; conflicts: string[]; hasPublishedPeriod: boolean; blocked: 'period_published' | null }
