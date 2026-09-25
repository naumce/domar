import { divRoundHalfUp } from '../money.js';
import { civilDayStart } from '../period.js';

/** The civil-day helper the windows are cut on; shared with `compliance/evaluate.ts`. */
export { civilDayStart } from '../period.js';

export type ReportFund = 'regular' | 'reserve';
/** The `postings.kind` labels; a report never invents one (spec §11). */
export type ReportPostingKind = 'charge' | 'payment' | 'expense' | 'adjustment' | 'opening';

/** `from` inclusive, `to` exclusive; both are UTC instants of local midnight in the tenant's zone. */
export interface ReportWindow { from: Date; to: Date }

/** The tenant's civil year: local midnight on 1 January to local midnight on the next 1 January. */
export function yearWindow(year: number, timeZone: string): ReportWindow {
  return { from: civilDayStart(`${year}-01-01`, timeZone), to: civilDayStart(`${year + 1}-01-01`, timeZone) };
}

/** One `(fund, kind, refType)` group of fund-account postings inside the window (plan addendum 6). */
export interface FundMovementIn {
  fund: ReportFund;
  kind: ReportPostingKind;
  refType: string;
  /** Σ of the group's positive amounts. */
  inflowMinor: number;
  /** Σ of the absolute value of the group's negative amounts. */
  outflowMinor: number;
}

export interface ReportExpense {
  id: string;
  fund: ReportFund;
  description: string;
  /** The supplier's name, the free-text supplier, or the pack's "no supplier" label. */
  supplier: string;
  amountMinor: number;
  paidAt: string;
}

export interface ReportOwner {
  contactId: string;
  name: string;
  unitLabels: string[];
  /** Σ owner charges inside the window. */
  billedMinor: number;
  /** Σ owner payments inside the window, sign-flipped so a payment is positive (addendum 7). */
  collectedMinor: number;
  /** The owner's balance at the end of the window; positive = owes. */
  balanceMinor: number;
}

export interface ReportAssembly { heldAt: string; decisionCount: number }

export interface AnnualReportInput {
  year: number;
  /** ISO instants of the window this report covers; `to` is exclusive. */
  window: { from: string; to: string };
  building: { name: string; address: string; city: string; postalCode: string; unitCount: number };
  manager: { name: string; companyNumber: string | null };
  /** Σ fund postings booked strictly before `window.from`, per fund. */
  opening: Record<ReportFund, number>;
  fundMovements: FundMovementIn[];
  expenses: ReportExpense[];
  owners: ReportOwner[];
  remindersSent: number;
  assemblies: ReportAssembly[];
}

export interface FundMovement { kind: ReportPostingKind; refType: string; inflowMinor: number; outflowMinor: number; netMinor: number }
export interface FundSummary {
  fund: ReportFund;
  openingMinor: number;
  inflowMinor: number;
  outflowMinor: number;
  /** Always `openingMinor + inflowMinor − outflowMinor` (plan addendum 5). */
  closingMinor: number;
  movements: FundMovement[];
}
export interface SupplierTotal { supplier: string; count: number; amountMinor: number }
export interface DebtorRow { contactId: string; name: string; unitLabels: string[]; balanceMinor: number }

export interface AnnualReportData {
  /** Every scalar the template prints as a labelled value, in one map (spec §7, plan addendum 3). */
  fields: Record<string, string | number>;
  funds: FundSummary[];
  expenses: ReportExpense[];
  expensesBySupplier: SupplierTotal[];
  /** Art. 45: what the reserve fund paid for (plan addendum 4). */
  works: ReportExpense[];
  owners: ReportOwner[];
  debtors: DebtorRow[];
  assemblies: ReportAssembly[];
}

const FUNDS: readonly ReportFund[] = ['regular', 'reserve'];

function summariseFund(fund: ReportFund, openingMinor: number, movements: FundMovementIn[]): FundSummary {
  const byKey = new Map<string, FundMovement>();
  let inflowMinor = 0;
  let outflowMinor = 0;
  for (const m of movements) {
    if (m.fund !== fund) continue;
    inflowMinor += m.inflowMinor;
    outflowMinor += m.outflowMinor;
    const key = `${m.kind}|${m.refType}`;
    const e = byKey.get(key) ?? { kind: m.kind, refType: m.refType, inflowMinor: 0, outflowMinor: 0, netMinor: 0 };
    e.inflowMinor += m.inflowMinor;
    e.outflowMinor += m.outflowMinor;
    e.netMinor = e.inflowMinor - e.outflowMinor;
    byKey.set(key, e);
  }
  const rows = [...byKey.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.refType.localeCompare(b.refType));
  return { fund, openingMinor, inflowMinor, outflowMinor, closingMinor: openingMinor + inflowMinor - outflowMinor, movements: rows };
}

/**
 * Art. 31, one building, one window. Pure: the same input always gives the same report, which is
 * what makes the figures on a filed PDF reproducible years later from the event's evidence.
 */
export function buildAnnualReport(input: AnnualReportInput): AnnualReportData {
  const funds = FUNDS.map((f) => summariseFund(f, input.opening[f] ?? 0, input.fundMovements));
  const regular = funds[0]!;
  const reserve = funds[1]!;

  const expenses = [...input.expenses].sort((a, b) => a.paidAt.localeCompare(b.paidAt) || a.id.localeCompare(b.id));
  const bySupplier = new Map<string, SupplierTotal>();
  for (const e of expenses) {
    const t = bySupplier.get(e.supplier) ?? { supplier: e.supplier, count: 0, amountMinor: 0 };
    t.count += 1;
    t.amountMinor += e.amountMinor;
    bySupplier.set(e.supplier, t);
  }
  const expensesBySupplier = [...bySupplier.values()].sort((a, b) => b.amountMinor - a.amountMinor || a.supplier.localeCompare(b.supplier));
  const works = expenses.filter((e) => e.fund === 'reserve');

  const owners = [...input.owners].sort((a, b) => a.name.localeCompare(b.name) || a.contactId.localeCompare(b.contactId));
  const debtors: DebtorRow[] = owners
    .filter((o) => o.balanceMinor > 0)
    .map((o) => ({ contactId: o.contactId, name: o.name, unitLabels: o.unitLabels, balanceMinor: o.balanceMinor }))
    .sort((a, b) => b.balanceMinor - a.balanceMinor || a.name.localeCompare(b.name));

  const billedMinor = owners.reduce((s, o) => s + o.billedMinor, 0);
  const collectedMinor = owners.reduce((s, o) => s + o.collectedMinor, 0);
  const expensesMinor = expenses.reduce((s, e) => s + e.amountMinor, 0);
  const worksMinor = works.reduce((s, e) => s + e.amountMinor, 0);
  const totalDebtMinor = debtors.reduce((s, d) => s + d.balanceMinor, 0);
  const assemblies = [...input.assemblies].sort((a, b) => a.heldAt.localeCompare(b.heldAt));

  return {
    fields: {
      year: input.year,
      periodFrom: input.window.from,
      periodTo: input.window.to,
      buildingName: input.building.name,
      buildingAddress: `${input.building.address}, ${input.building.postalCode} ${input.building.city}`,
      managerName: input.manager.name,
      managerCompanyNumber: input.manager.companyNumber ?? '',
      unitCount: input.building.unitCount,
      ownerCount: owners.length,
      regularOpeningMinor: regular.openingMinor,
      regularInflowMinor: regular.inflowMinor,
      regularOutflowMinor: regular.outflowMinor,
      regularClosingMinor: regular.closingMinor,
      reserveOpeningMinor: reserve.openingMinor,
      reserveInflowMinor: reserve.inflowMinor,
      reserveOutflowMinor: reserve.outflowMinor,
      reserveClosingMinor: reserve.closingMinor,
      billedMinor,
      collectedMinor,
      expensesMinor,
      // Basis points, like every other rate in this codebase, and integer-rounded half up so the
      // printed percentage never drifts from the two numbers printed beside it.
      collectionRateBp: billedMinor === 0 ? 0 : divRoundHalfUp(collectedMinor * 10_000, billedMinor),
      debtorsCount: debtors.length,
      totalDebtMinor,
      remindersSent: input.remindersSent,
      assembliesHeld: assemblies.length,
      decisionsTaken: assemblies.reduce((s, a) => s + a.decisionCount, 0),
      worksCount: works.length,
      worksMinor,
    },
    funds,
    expenses,
    expensesBySupplier,
    works,
    owners,
    debtors,
    assemblies,
  };
}
