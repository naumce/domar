import type { ReminderRules } from '../country/types.js';
import { comparePeriods, nextPeriod } from '../period.js';

/** One unpaid invoice of a single owner in a single building. `dueAt` is an ISO date or date-time. */
export interface UnpaidInvoice {
  id: string;
  period: string;
  dueAt: string;
  outstandingMinor: number;
}

/** A reminder already created for this owner in this building. `sentAt` is `sentAt ?? createdAt` on the API side. */
export interface PriorReminder {
  sentAt: string;
  invoiceIds: string[];
}

export interface OwnerReminderInput {
  invoices: UnpaidInvoice[];
  priorReminders: PriorReminder[];
}

export type ReminderReason = 'consecutive' | 'total';

export interface ReminderEvaluation {
  due: boolean;
  reason: ReminderReason | null;
  invoiceIds: string[];
}

const SUPPRESSION_MS = 30 * 24 * 60 * 60 * 1000;
/** A fresh object every time: callers own the result and may sort or push into `invoiceIds`. */
const notDue = (): ReminderEvaluation => ({ due: false, reason: null, invoiceIds: [] });

/** Longest run of consecutive months in an ascending list of distinct periods. */
function longestRun(periods: string[]): number {
  let best = 1;
  let run = 1;
  for (let i = 1; i < periods.length; i += 1) {
    run = periods[i]! === nextPeriod(periods[i - 1]!) ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}

/**
 * Art. 28 of the Law on Housing (MK): a reminder is due when `rules.consecutiveUnpaid` consecutive
 * periods are unpaid and past due, or `rules.totalUnpaid` periods in total are, and no reminder
 * covering the same debt went out in the last 30 days. `rules.feeAllowed` is never read because
 * nothing here produces a fee: there is no code path in domar that books one.
 */
export function evaluateOwner(input: OwnerReminderInput, rules: ReminderRules, today: Date): ReminderEvaluation {
  const nowMs = today.getTime();
  const overdue = input.invoices.filter((i) => i.outstandingMinor > 0 && Date.parse(i.dueAt) < nowMs);
  if (overdue.length === 0) return notDue();

  const periods = [...new Set(overdue.map((i) => i.period))].sort((a, b) => comparePeriods(a, b));
  const reason: ReminderReason | null = longestRun(periods) >= rules.consecutiveUnpaid
    ? 'consecutive'
    : periods.length >= rules.totalUnpaid
      ? 'total'
      : null;
  if (reason === null) return notDue();

  // Sorted so the same debt always yields the same set, whatever order the query returned.
  const invoiceIds = overdue.map((i) => i.id).sort();
  const suppressed = input.priorReminders.some((r) =>
    nowMs - Date.parse(r.sentAt) < SUPPRESSION_MS && invoiceIds.every((id) => r.invoiceIds.includes(id)));
  return suppressed ? notDue() : { due: true, reason, invoiceIds };
}
