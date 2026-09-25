import type { MaintenanceCategory, MaintenancePriority, MaintenanceStatus } from '@domar/domain';

export interface User { id: string; email: string; firstName: string; lastName: string; role: 'owner' | 'accountant' | 'technician' | 'readonly'; isActive: boolean }
export interface CreatedUser { user: User; temporaryPassword: string }
export interface Tenant {
  id: string; slug: string; name: string; countryCode: string; currency: string; locale: string; timezone: string;
  companyNumber: string | null; vatNumber: string | null; address: string | null; phone: string | null; email: string | null; bankName: string | null; bankAccount: string | null;
  emailConfigured: boolean;
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
export interface Expense { id: string; buildingId: string; fund: Fund; description: string; supplierText: string | null; supplierId: string | null; documentId: string | null; amountMinor: number; paidAt: string; voidedAt: string | null; voidReason: string | null; createdAt: string }
export interface FundTransaction { id: string; kind: 'charge' | 'payment' | 'expense' | 'adjustment' | 'opening'; fund: Fund; amountMinor: number; refType: string; refId: string | null; bookedAt: string; description: string | null }
export interface PeriodLine { id: string; serviceId: string | null; description: string; pricing: PricingModel; quantity: number; unitPriceMinor: number; taxRateBp: number; appliesTo: UnitKind[]; fund: Fund; source: 'auto' | 'manual'; note: string | null; sortOrder: number }
export interface Period { id: string; buildingId: string; period: string; status: 'open' | 'generated' | 'published'; kind: 'regular' | 'extraordinary'; distributionBasis: 'area' | 'equal' | 'custom' | null; managementFeeMinor: number; managementFeeTaxRateBp: number; managementFeeAppliesTo: UnitKind[]; numberPrefix: string; numberSuffix: string; currency: string; issuedAt: string | null; dueAt: string | null; generatedAt: string | null; publishedAt: string | null; warnings: Record<string, unknown>[]; invoiceCount: number; totalMinor: number; lines?: PeriodLine[] }
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
/** What `/api/portal/payments` returns: the manager's own bookkeeping fields are not on the wire. */
export type PortalPayment = Omit<Payment, 'note' | 'statementLineId' | 'voidReason'>;
export type PortalInvoice = Omit<Invoice, 'payments'> & { payments: PortalPayment[] };
export interface PaymentSummary { totalMinor: number; completedCount: number; voidedCount: number; byMethod: { method: PaymentMethod; totalMinor: number }[] }
export type MatchStatus = 'unmatched' | 'suggested' | 'matched' | 'ignored';
export interface BankStatement { id: string; buildingId: string; filename: string; format: string; accountNumber: string | null; lineCount: number; matchedCount: number; skippedCount: number; importedAt: string }
export interface StatementLine {
  id: string; statementId: string; lineNo: number; bookedAt: string; amountMinor: number; counterparty: string | null; reference: string | null;
  matchStatus: MatchStatus; confidence: string | null;
  suggestedInvoice: { id: string; number: string | null; contactLastName: string; outstandingMinor: number } | null;
  payment: { id: string; amountMinor: number; status: 'completed' | 'voided' } | null;
}
export interface DashboardStats { totalProperties: number; totalUnits: number; assignedOwners: number; billedThisMonthMinor: number; paidThisMonthMinor: number; unpaidInvoices: number; outstandingMinor: number; complianceAttention: number }
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
export type ReminderReason = 'consecutive' | 'total';
export type ReminderChannel = 'email' | 'letter';
export type ReminderStatus = 'pending' | 'sent' | 'failed' | 'printed';
export interface Reminder {
  id: string; buildingId: string; contactId: string; reason: ReminderReason; invoiceIds: string[]; invoiceNumbers: string[];
  totalOutstandingMinor: number; channel: ReminderChannel; status: ReminderStatus; sentAt: string | null; error: string | null;
  contact: { id: string; firstName: string; lastName: string; email: string | null }; createdAt: string;
}
export interface EmailSendResult { id: string; status: 'sent' | 'failed'; to: string; error: string | null }
export interface EmailBulkResult { sent: number; failed: number; skipped: number }
export interface PortalLink { tenantId: string; tenantName: string; contactId: string; contactName: string; buildings: { id: string; name: string }[] }
export interface PortalMe { account: { id: string; email: string }; links: PortalLink[] }
export interface PortalFund {
  building: { id: string; name: string };
  regular: { balanceMinor: number; billedMinor: number };
  reserve: { balanceMinor: number; billedMinor: number };
  transactions: { id: string; kind: FundTransaction['kind']; fund: Fund; amountMinor: number; bookedAt: string; description: string | null }[];
  truncated: boolean;
}
export interface PortalInvite { code: string; expiresAt: string; emailed: boolean }
export interface PortalStatus { status: 'none' | 'invited' | 'linked'; expiresAt?: string; linkedAt?: string }

export type ComplianceStatus = 'ok' | 'due' | 'overdue' | 'n/a';
export type ComplianceDutyKey = 'invoices' | 'reminders' | 'assembly' | 'annual_report' | 'fund_transparency' | 'fund_accounts' | 'handover' | 'extraordinary_costs';
export interface ComplianceDuty {
  key: ComplianceDutyKey; article: string; status: ComplianceStatus; dueAt: string | null; lastEvidenceAt: string | null;
  /** Query string relative to `/app/buildings/<id>`. */
  howToFix: string; count: number | null; label: string; hint: string; flags: string[];
}
export interface ComplianceCounts { ok: number; due: number; overdue: number; na: number }
export interface BuildingCompliance {
  building: { id: string; name: string }; status: ComplianceStatus; counts: ComplianceCounts;
  duties: ComplianceDuty[]; evaluatedAt: string;
}
export interface ComplianceOverviewRow {
  building: { id: string; name: string }; status: ComplianceStatus; counts: ComplianceCounts;
  duties: { key: ComplianceDutyKey; status: ComplianceStatus }[];
}
export interface ComplianceOverview { rows: ComplianceOverviewRow[]; counts: ComplianceCounts; evaluatedAt: string }
export type LegalEventKind = 'invoice_published' | 'reminder_sent' | 'assembly_invited' | 'assembly_held' | 'annual_report_issued' | 'handover_report_issued' | 'fund_statement_available' | 'extraordinary_cost_distributed';
export interface LegalEvent {
  id: string; buildingId: string; kind: LegalEventKind; refType: string; refId: string | null;
  occurredAt: string; dueAt: string | null; evidence: Record<string, unknown>; createdBy: string | null; createdAt: string;
}

export type DocumentKind = 'contract' | 'minutes' | 'report' | 'invoice_supplier' | 'photo' | 'other';
export interface DocumentMeta {
  id: string; buildingId: string | null; kind: DocumentKind; title: string; fileName: string; mime: string;
  sizeBytes: number; sha256: string; uploadedBy: string | null; createdAt: string;
}
export interface Supplier {
  id: string; name: string; companyNumber: string | null; vatNumber: string | null; email: string | null;
  phone: string | null; iban: string | null; notes: string | null; isActive: boolean;
}
export type ContractKind = 'management' | 'service' | 'insurance' | 'other';
export interface BuildingContract {
  id: string; buildingId: string; supplierId: string | null; kind: ContractKind; title: string;
  startsOn: string; endsOn: string | null; noticeDays: number; amountMinor: number | null; documentId: string | null;
  supplier: { id: string; name: string } | null;
  document: { id: string; title: string; fileName: string } | null;
}
export interface ReportFundSummary {
  fund: Fund; openingMinor: number; inflowMinor: number; outflowMinor: number;
  /** Gross less what the reversals took back: what the fund really took in and really spent. */
  netInflowMinor: number; netOutflowMinor: number;
  closingMinor: number;
  movements: { kind: string; refType: string; inflowMinor: number; outflowMinor: number; netMinor: number }[];
}
export interface ReportExpenseRow { id: string; fund: Fund; description: string; supplier: string; amountMinor: number; paidAt: string }
/** `current` is false for somebody who owned during the window but owns nothing at its end. */
export interface ReportOwnerRow { contactId: string; name: string; unitLabels: string[]; current: boolean; billedMinor: number; collectedMinor: number; balanceMinor: number }
export interface ReportDebtorRow { contactId: string; name: string; unitLabels: string[]; balanceMinor: number }
/** `fields` is the flat map the PDF template prints; every money key in it ends in `Minor`. */
export interface AnnualReportData {
  fields: Record<string, string | number>;
  funds: ReportFundSummary[];
  expenses: ReportExpenseRow[];
  expensesBySupplier: { supplier: string; count: number; amountMinor: number }[];
  works: ReportExpenseRow[];
  owners: ReportOwnerRow[];
  debtors: ReportDebtorRow[];
  assemblies: { heldAt: string; decisionCount: number }[];
}
export type ReportKind = 'annual' | 'handover';
export interface ReportRow {
  eventId: string; kind: ReportKind; occurredAt: string;
  documentId: string | null; exportDocumentId: string | null;
  title: string; fileName: string; sizeBytes: number; evidence: Record<string, unknown>;
}
export interface ReportList { rows: ReportRow[]; documents: DocumentMeta[] }
export interface ReportIssueResult {
  document: DocumentMeta; exportDocumentId: string | null; eventId: string; year: number;
  fields: Record<string, string | number>;
}
export type Distribution = 'share' | 'equal' | 'area';
export interface ExtraordinaryCostResult { periodId: string; period: string; invoiceCount: number; totalMinor: number; invoiceIds: string[] }

export type AssemblyStatus = 'draft' | 'invited' | 'held' | 'cancelled';
export type QuorumBasis = 'share' | 'count';
export type VoteChoice = 'for' | 'against' | 'abstain';
export type DecisionResult = 'pending' | 'passed' | 'rejected' | 'no_quorum';
export interface AgendaItem { id: string; title: string; text: string }
export interface AssemblyDecision {
  id: string; title: string; text: string | null; sortOrder: number;
  forWeight: number; againstWeight: number; abstainWeight: number;
  presentWeight: number; basisTotal: number; quorumReached: boolean; result: DecisionResult;
}
export interface AssemblyInvitation {
  id: string; contactId: string; contactName: string; email: string | null;
  channel: 'email' | 'letter'; status: 'pending' | 'sent' | 'failed' | 'printed' | 'cancelled'; sentAt: string | null; error: string | null;
}
export interface AssemblyAttendee { contactId: string; contactName: string; present: boolean; proxyName: string | null; weightBp: number }
export interface AssemblyVote { decisionId: string; contactId: string; choice: VoteChoice; via: 'portal' | 'paper'; castAt: string }
export interface AssemblyRow {
  id: string; buildingId: string; scheduledAt: string; location: string; agenda: AgendaItem[];
  status: AssemblyStatus; quorumBasis: QuorumBasis; invitedAt: string | null; heldAt: string | null;
  cancelledAt: string | null; cancelReason: string | null; lateInvitation: boolean; lateReason: string | null;
  minutesDocumentId: string | null; decisionCount: number; invitationCount: number; createdAt: string; updatedAt: string;
}
export interface Assembly extends AssemblyRow {
  decisions: AssemblyDecision[]; invitations: AssemblyInvitation[]; attendance: AssemblyAttendee[]; votes: AssemblyVote[];
}
export interface AssemblyOwnerRow { contactId: string; contactName: string; email: string | null; weightBp: number }
export interface AssemblyOwners { rows: AssemblyOwnerRow[]; basisTotal: number; quorumBasis: QuorumBasis }
export interface PortalAssemblyRow {
  id: string; buildingId: string; buildingName: string; scheduledAt: string; location: string;
  status: 'invited' | 'held'; heldAt: string | null; minutesDocumentId: string | null; agendaCount: number;
}
export interface PortalAssemblyDecision {
  id: string; title: string; text: string | null; myChoice: VoteChoice | null;
  forWeight: number | null; againstWeight: number | null; abstainWeight: number | null;
  presentWeight: number | null; basisTotal: number | null; quorumReached: boolean | null; result: DecisionResult | null;
}
export interface PortalAssembly extends Omit<PortalAssemblyRow, 'agendaCount'> {
  agenda: AgendaItem[]; votingOpen: boolean; decisions: PortalAssemblyDecision[];
}

// The three the domain owns, re-exported rather than restated: one list, one place to add to.
export type { MaintenanceCategory, MaintenancePriority, MaintenanceStatus };
export type MaintenanceEventKind = 'created' | 'status_changed' | 'assigned' | 'comment' | 'photo_added';
export type MaintenanceVisibility = 'internal' | 'owner';
export interface MaintenancePhoto {
  documentId: string; title: string; fileName: string; mime: string; sizeBytes: number; uploadedByName: string; createdAt: string;
}
export interface MaintenanceEvent {
  id: string; kind: MaintenanceEventKind; fromStatus: MaintenanceStatus | null; toStatus: MaintenanceStatus | null;
  note: string; visibility: MaintenanceVisibility; authorName: string; authorKind: 'manager' | 'owner' | 'system'; createdAt: string;
}
export interface MaintenanceRow {
  id: string; buildingId: string; unitId: string | null; unitLabel: string | null;
  title: string; category: MaintenanceCategory; priority: MaintenancePriority; status: MaintenanceStatus;
  reporterName: string; reporterKind: 'manager' | 'owner';
  assigneeUserId: string | null; assigneeName: string | null; supplierId: string | null; supplierName: string | null;
  fund: Fund | null; costMinor: number | null; expenseId: string | null; photoCount: number;
  closedAt: string | null; createdAt: string; updatedAt: string;
}
export interface MaintenanceRequest extends MaintenanceRow {
  description: string; photos: MaintenancePhoto[]; events: MaintenanceEvent[];
}
export interface PortalMaintenancePhoto { documentId: string; fileName: string; mime: string; sizeBytes: number; createdAt: string }
export interface PortalMaintenanceEvent {
  id: string; kind: MaintenanceEventKind; toStatus: MaintenanceStatus | null; note: string;
  authorName: string; authorKind: 'manager' | 'owner' | 'system'; createdAt: string;
}
export interface PortalMaintenanceRow {
  id: string; buildingId: string; buildingName: string; unitLabel: string | null;
  title: string; category: MaintenanceCategory; priority: MaintenancePriority; status: MaintenanceStatus;
  photoCount: number; closedAt: string | null; createdAt: string; updatedAt: string;
}
export interface PortalMaintenanceRequest extends PortalMaintenanceRow {
  description: string; photos: PortalMaintenancePhoto[]; events: PortalMaintenanceEvent[];
}

export type NotificationKind =
  | 'invoice_published' | 'reminder_created' | 'assembly_invited' | 'assembly_voting_opened'
  | 'maintenance_status' | 'maintenance_request_created' | 'delivery_failed';
export interface NotificationRow { id: string; kind: NotificationKind; title: string; body: string; link: string; createdAt: string; readAt: string | null }
export interface NotificationList { rows: NotificationRow[]; unread: number }
