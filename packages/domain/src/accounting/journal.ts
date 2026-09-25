import { type AccountRef, ACCOUNT_SLOTS, type AccountSlot, type Chart, chartFrom, missingSlots } from './slots.js';

export { ACCOUNT_SLOTS, chartFrom, missingSlots };
export type { AccountRef, AccountSlot, Chart };

export type JournalFund = 'regular' | 'reserve';
export type JournalAccount = 'owner' | 'fund';
export type JournalKind = 'charge' | 'payment' | 'expense' | 'adjustment' | 'opening';
export type JournalLineKind = 'service' | 'manual' | 'reserve_fund' | 'management_fee';

/**
 * One `postings` row, already resolved by the caller: the period it belongs to, the civil day it
 * happened on in the tenant's zone, and the names a human reads. Nothing here needs a database, so
 * the derivation can be tested exhaustively without one (spec §4).
 */
export interface JournalPostingIn {
  id: string;
  account: JournalAccount;
  fund: JournalFund;
  kind: JournalKind;
  /** Signed minor units, straight off the ledger. Owner positive means the owner owes. */
  amountMinor: number;
  refType: string;
  refId: string | null;
  /** `YYYY-MM` — the posting's own `period`, else the civil month of `bookedAt`. */
  period: string;
  /** `YYYY-MM-DD` in the tenant's zone. */
  date: string;
  buildingName: string;
  counterparty: string;
  /** Booked before the window and reported in it: a prior-period adjustment (spec §5). */
  prior: boolean;
}

export interface JournalInvoiceIn {
  number: string;
  lines: readonly { kind: JournalLineKind; ownerNetMinor: number; ownerTaxMinor: number; ownerGrossMinor: number }[];
}

export interface JournalExpenseIn {
  description: string;
  /** The supplier's own account, when it has one; else the derivation uses `expense_default`. */
  account: AccountRef | null;
}

export interface JournalInput {
  chart: Chart;
  postings: readonly JournalPostingIn[];
  /** Keyed by invoice id — every invoice named by a `charge` posting in `postings`. */
  invoices: Readonly<Record<string, JournalInvoiceIn>>;
  /** Keyed by expense id — every expense named by an `expense`/`expense_void` posting. */
  expenses: Readonly<Record<string, JournalExpenseIn>>;
  /** The periods already closed, for the README and the adjustments section. */
  closedPeriods: readonly string[];
}

export interface JournalLine {
  code: string;
  name: string;
  debitMinor: number;
  creditMinor: number;
  description: string;
}

export interface JournalEntry {
  no: number;
  date: string;
  period: string;
  buildingName: string;
  counterparty: string;
  sourceType: string;
  sourceId: string;
  /** True for an entry in the adjustments section whose period had already been closed. */
  closedPeriod: boolean;
  lines: JournalLine[];
}

export interface TrialBalanceRow {
  code: string;
  name: string;
  debitMinor: number;
  creditMinor: number;
  differenceMinor: number;
}

export interface Journal {
  entries: JournalEntry[];
  adjustments: JournalEntry[];
  trialBalance: TrialBalanceRow[];
  totals: { debitMinor: number; creditMinor: number; entryCount: number; lineCount: number };
  closedPeriods: string[];
}

/** The one error this module raises. Its `code` is the API's error code and the web's i18n key. */
export class JournalError extends Error {
  constructor(
    public readonly code: 'unbalanced_entry' | 'unbalanced_file' | 'unknown_source',
    message: string,
    public readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'JournalError';
  }
}

const REVENUE_SLOT: Record<JournalLineKind, AccountSlot> = {
  service: 'revenue_service',
  manual: 'revenue_service',
  management_fee: 'revenue_management_fee',
  reserve_fund: 'revenue_reserve_fund',
};

const CASH_SLOT: Record<JournalFund, AccountSlot> = { regular: 'cash_regular', reserve: 'cash_reserve' };

const KNOWN = new Set(['invoice', 'payment', 'payment_void', 'expense', 'expense_void', 'opening_balance']);

/** A group is one accounting event: everything sharing a source. An opening balance has no `refId`. */
function groupKey(p: JournalPostingIn): string {
  return p.refType === 'opening_balance' ? `opening_balance:${p.id}` : `${p.refType}:${p.refId ?? p.id}`;
}

const debit = (a: AccountRef, minor: number, description: string): JournalLine =>
  ({ code: a.code, name: a.name, debitMinor: minor, creditMinor: 0, description });
const credit = (a: AccountRef, minor: number, description: string): JournalLine =>
  ({ code: a.code, name: a.name, debitMinor: 0, creditMinor: minor, description });

/** A signed amount against one account: positive is a debit, negative a credit of its absolute value. */
const signed = (a: AccountRef, minor: number, description: string): JournalLine =>
  (minor >= 0 ? debit(a, minor, description) : credit(a, -minor, description));

function invoiceLines(chart: Chart, group: JournalPostingIn[], invoice: JournalInvoiceIn): JournalLine[] {
  const gross = group.reduce((s, p) => s + p.amountMinor, 0);
  const byRevenue = new Map<AccountSlot, number>();
  let tax = 0;
  for (const l of invoice.lines) {
    byRevenue.set(REVENUE_SLOT[l.kind], (byRevenue.get(REVENUE_SLOT[l.kind]) ?? 0) + l.ownerNetMinor);
    tax += l.ownerTaxMinor;
  }
  const out = [debit(chart.owner_receivable, gross, invoice.number)];
  // Canonical slot order, so two runs of the same month produce byte-identical files.
  for (const slot of ACCOUNT_SLOTS) {
    const net = byRevenue.get(slot);
    if (net !== undefined) out.push(credit(chart[slot], net, invoice.number));
  }
  if (tax !== 0) out.push(credit(chart.vat_output, tax, invoice.number));
  return out;
}

function expenseLines(chart: Chart, p: JournalPostingIn, expense: JournalExpenseIn): JournalLine[] {
  const account = expense.account ?? chart.expense_default;
  const cash = chart[CASH_SLOT[p.fund]];
  // Money out is a negative fund posting: debit the expense, credit the cash. A void is the reverse.
  return p.amountMinor < 0
    ? [debit(account, -p.amountMinor, expense.description), credit(cash, -p.amountMinor, expense.description)]
    : [debit(cash, p.amountMinor, expense.description), credit(account, p.amountMinor, expense.description)];
}

function openingLines(chart: Chart, p: JournalPostingIn, description: string): JournalLine[] {
  const side = p.account === 'owner' ? chart.owner_receivable : chart[CASH_SLOT[p.fund]];
  return [signed(side, p.amountMinor, description), signed(chart.opening_balance, -p.amountMinor, description)];
}

/**
 * A payment and its void are the same shape: the ledger already wrote both sides, so each posting
 * becomes one line against its own account and the group balances because the ledger's does.
 */
function cashLines(chart: Chart, group: JournalPostingIn[], description: string): JournalLine[] {
  const byAccount = new Map<string, { account: AccountRef; minor: number }>();
  for (const p of group) {
    const account = p.account === 'owner' ? chart.owner_receivable : chart[CASH_SLOT[p.fund]];
    const at = byAccount.get(account.code) ?? { account, minor: 0 };
    at.minor += p.amountMinor;
    byAccount.set(account.code, at);
  }
  return [...byAccount.values()]
    .filter((x) => x.minor !== 0)
    .sort((a, b) => Number(b.minor > 0) - Number(a.minor > 0))
    .map((x) => signed(x.account, x.minor, description));
}

function entryLines(input: JournalInput, group: JournalPostingIn[]): JournalLine[] {
  const head = group[0]!;
  switch (head.refType) {
    case 'invoice': {
      const invoice = input.invoices[head.refId!];
      if (!invoice) throw new JournalError('unknown_source', `no invoice ${head.refId} for posting ${head.id}`, { refType: 'invoice', postingId: head.id, refId: head.refId });
      return invoiceLines(input.chart, group, invoice);
    }
    case 'payment':
    case 'payment_void':
      return cashLines(input.chart, group, head.counterparty);
    case 'expense':
    case 'expense_void': {
      const expense = input.expenses[head.refId!];
      if (!expense) throw new JournalError('unknown_source', `no expense ${head.refId} for posting ${head.id}`, { refType: head.refType, postingId: head.id, refId: head.refId });
      return expenseLines(input.chart, head, expense);
    }
    case 'opening_balance':
      return openingLines(input.chart, head, head.counterparty);
    default:
      throw new JournalError('unknown_source', `unknown refType ${head.refType}`, { refType: head.refType, postingId: head.id });
  }
}

/**
 * The ledger as a balanced double-entry journal (spec §4). Pure: the same rows always produce the
 * same file. Money stays in integer minor units throughout; only the CSV writer renders it.
 *
 * Balance is an invariant, not a feature: an entry that does not sum to zero stops the whole build
 * and says which entry and by how much, because a file that silently does not balance cannot be
 * posted and is worse than no file at all (spec §2).
 */
export function buildJournal(input: JournalInput): Journal {
  for (const p of input.postings) {
    if (!KNOWN.has(p.refType)) throw new JournalError('unknown_source', `unknown refType ${p.refType}`, { refType: p.refType, postingId: p.id });
  }
  const groups = new Map<string, JournalPostingIn[]>();
  for (const p of input.postings) {
    const key = groupKey(p);
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }
  const closed = new Set(input.closedPeriods);
  const ordered = [...groups.values()].sort((a, b) => {
    const [x, y] = [a[0]!, b[0]!];
    // Adjustments last, then oldest first, then a stable tiebreak so two runs agree byte for byte.
    return Number(x.prior) - Number(y.prior) || x.date.localeCompare(y.date)
      || x.refType.localeCompare(y.refType) || groupKey(x).localeCompare(groupKey(y));
  });

  const entries: JournalEntry[] = [];
  const adjustments: JournalEntry[] = [];
  let no = 0;
  for (const group of ordered) {
    const head = group[0]!;
    const sourceId = head.refType === 'opening_balance' ? head.id : head.refId!;
    no += 1;
    const lines = entryLines(input, group).filter((l) => l.debitMinor !== 0 || l.creditMinor !== 0);
    const difference = lines.reduce((s, l) => s + l.debitMinor - l.creditMinor, 0);
    if (difference !== 0) {
      throw new JournalError('unbalanced_entry', `entry ${no} (${head.refType} ${sourceId}) is out by ${difference} minor units`,
        { entryNo: no, sourceType: head.refType, sourceId, differenceMinor: difference });
    }
    const entry: JournalEntry = {
      no, date: head.date, period: head.period, buildingName: head.buildingName, counterparty: head.counterparty,
      sourceType: head.refType, sourceId, closedPeriod: closed.has(head.period), lines,
    };
    (head.prior ? adjustments : entries).push(entry);
  }

  const all = [...entries, ...adjustments];
  const totals = { debitMinor: 0, creditMinor: 0, entryCount: all.length, lineCount: 0 };
  const byAccount = new Map<string, TrialBalanceRow>();
  for (const e of all) {
    for (const l of e.lines) {
      totals.debitMinor += l.debitMinor;
      totals.creditMinor += l.creditMinor;
      totals.lineCount += 1;
      const row = byAccount.get(l.code) ?? { code: l.code, name: l.name, debitMinor: 0, creditMinor: 0, differenceMinor: 0 };
      row.debitMinor += l.debitMinor;
      row.creditMinor += l.creditMinor;
      row.differenceMinor = row.debitMinor - row.creditMinor;
      byAccount.set(l.code, row);
    }
  }
  if (totals.debitMinor !== totals.creditMinor) {
    // Unreachable while every entry balances, and kept anyway: this is the check the whole file
    // rests on, and an arithmetic slip above must stop the export rather than ship a broken one.
    throw new JournalError('unbalanced_file', `the file is out by ${totals.debitMinor - totals.creditMinor} minor units`,
      { differenceMinor: totals.debitMinor - totals.creditMinor });
  }
  const covered = new Set(all.map((e) => e.period));
  return {
    entries, adjustments,
    trialBalance: [...byAccount.values()].sort((a, b) => a.code.localeCompare(b.code)),
    totals,
    closedPeriods: [...covered].filter((p) => closed.has(p)).sort(),
  };
}
