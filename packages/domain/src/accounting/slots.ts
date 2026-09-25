/**
 * The fixed set of account slots the derivation needs, and the only ones (spec §3). The order is
 * canonical: `missingSlots` reports in it, and the chart screen lists in it.
 */
export const ACCOUNT_SLOTS = [
  'owner_receivable', 'revenue_service', 'revenue_management_fee', 'revenue_reserve_fund',
  'vat_output', 'cash_regular', 'cash_reserve', 'expense_default', 'opening_balance',
] as const;

export type AccountSlot = (typeof ACCOUNT_SLOTS)[number];

/** One account as the accountant knows it: their own code and their own name for it. */
export interface AccountRef {
  code: string;
  name: string;
}

/** Every slot mapped. The export refuses to run without one (spec §3). */
export type Chart = Record<AccountSlot, AccountRef>;

/**
 * Every slot with no usable code, in canonical order. A blank code or an inactive row counts as
 * unmapped: a half-mapped chart produces a file that looks right and posts wrong.
 */
export function missingSlots(rows: readonly { slot: AccountSlot; code: string; isActive: boolean }[]): AccountSlot[] {
  const mapped = new Set(rows.filter((r) => r.isActive && r.code.trim() !== '').map((r) => r.slot));
  return ACCOUNT_SLOTS.filter((s) => !mapped.has(s));
}

/** The rows as the derivation wants them. Callers check `missingSlots` first; a gap here is a bug. */
export function chartFrom(rows: readonly { slot: AccountSlot; code: string; name: string; isActive: boolean }[]): Chart {
  const by = new Map(rows.filter((r) => r.isActive).map((r) => [r.slot, { code: r.code, name: r.name }]));
  const out = {} as Chart;
  for (const slot of ACCOUNT_SLOTS) {
    const ref = by.get(slot);
    if (!ref) throw new RangeError(`account slot ${slot} is not mapped`);
    out[slot] = ref;
  }
  return out;
}
