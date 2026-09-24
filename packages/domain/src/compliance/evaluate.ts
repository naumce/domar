import type { ComplianceRules } from '../country/types.js';

export type ComplianceDutyKey =
  | 'invoices' | 'reminders' | 'assembly' | 'annual_report'
  | 'fund_transparency' | 'fund_accounts' | 'handover' | 'extraordinary_costs';

export type ComplianceStatus = 'ok' | 'due' | 'overdue' | 'n/a';

export const COMPLIANCE_DUTY_KEYS: readonly ComplianceDutyKey[] = [
  'invoices', 'reminders', 'assembly', 'annual_report', 'fund_transparency', 'fund_accounts', 'handover', 'extraordinary_costs',
];

/** Bare citation codes: the word "article" belongs to the UI's locale, not to a multi-country rule. */
const ARTICLES: Record<ComplianceDutyKey, string> = {
  invoices: '19/33', reminders: '28', assembly: '37', annual_report: '31',
  fund_transparency: '45(4)', fund_accounts: '42/45', handover: '30', extraordinary_costs: '47(5)',
};

/** Relative to the building page: the web prepends `/app/buildings/<id>`. */
const HOW_TO_FIX: Record<ComplianceDutyKey, string> = {
  invoices: '?tab=periods',
  reminders: '?tab=reminders',
  assembly: '?tab=compliance',
  annual_report: '?tab=compliance',
  fund_transparency: '?tab=units',
  fund_accounts: '?tab=compliance#fund-accounts',
  handover: '?tab=contracts',
  extraordinary_costs: '?tab=extraordinary',
};

/**
 * Dates and counts the API reads out of events and columns (spec §3, §11). Every timestamp is an ISO
 * string with an offset; `managementContractEndsOn` is a `YYYY-MM-DD` date, which parses as UTC
 * midnight — the same grain `today` is given in.
 */
export interface ComplianceSnapshot {
  buildingCreatedAt: string;
  lastPublishedPeriodAt: string | null;
  /** Owners the Art. 28 evaluation says are due a reminder right now. */
  ownersOverThreshold: number;
  /** When the oldest of those owners' oldest overdue invoice fell due. */
  oldestThresholdSince: string | null;
  lastReminderAt: string | null;
  assemblyCount: number;
  lastAssemblyHeldAt: string | null;
  lastAssemblyInvitedAt: string | null;
  lastAnnualReportAt: string | null;
  portalLinkedOwners: number;
  fundStatementAvailableAt: string | null;
  regularFundAccount: string | null;
  reserveFundAccount: string | null;
  /** `YYYY-MM-DD` from the newest management contract, or null when there is none. */
  managementContractEndsOn: string | null;
  lastHandoverReportAt: string | null;
  extraordinaryCostCount: number;
}

export interface ComplianceDuty {
  key: ComplianceDutyKey;
  article: string;
  status: ComplianceStatus;
  /** The deadline this status was decided against; null when the duty has no date. */
  dueAt: string | null;
  lastEvidenceAt: string | null;
  /** Query string relative to the building page. */
  howToFix: string;
  /** Owners waiting, owners linked, costs distributed — null when the duty counts nothing. */
  count: number | null;
}

export interface ComplianceResult {
  status: ComplianceStatus;
  duties: ComplianceDuty[];
  counts: { ok: number; due: number; overdue: number; na: number };
}

const DAY_MS = 86_400_000;
const parse = (s: string | null): Date | null => (s === null ? null : new Date(s));
const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * DAY_MS);
const wholeDaysBetween = (from: Date, to: Date): number => Math.floor((to.getTime() - from.getTime()) / DAY_MS);

/** Calendar months in UTC; the 31st of a month lands on the last day of a shorter one. */
function addMonths(d: Date, n: number): Date {
  const day = d.getUTCDate();
  const firstOfTarget = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
  const t = new Date(firstOfTarget);
  const lastDay = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, lastDay));
  return t;
}

/** `ok` up to and including the deadline, `due` through the grace window, `overdue` after it. */
function windowStatus(deadline: Date, graceEnd: Date, today: Date): ComplianceStatus {
  if (today.getTime() <= deadline.getTime()) return 'ok';
  return today.getTime() <= graceEnd.getTime() ? 'due' : 'overdue';
}

function duty(key: ComplianceDutyKey, status: ComplianceStatus, dueAt: Date | null, lastEvidenceAt: string | null, count: number | null = null): ComplianceDuty {
  return { key, article: ARTICLES[key], status, dueAt: dueAt === null ? null : dueAt.toISOString(), lastEvidenceAt, howToFix: HOW_TO_FIX[key], count };
}

function invoicesDuty(s: ComplianceSnapshot, today: Date, r: ComplianceRules): ComplianceDuty {
  const ref = parse(s.lastPublishedPeriodAt) ?? new Date(s.buildingCreatedAt);
  const deadline = addDays(ref, r.invoiceMaxAgeDays);
  return duty('invoices', windowStatus(deadline, addDays(deadline, r.graceDays), today), deadline, s.lastPublishedPeriodAt);
}

function remindersDuty(s: ComplianceSnapshot, today: Date, r: ComplianceRules): ComplianceDuty {
  if (s.ownersOverThreshold === 0) return duty('reminders', 'ok', null, s.lastReminderAt, 0);
  const since = parse(s.oldestThresholdSince);
  if (since === null) return duty('reminders', 'due', null, s.lastReminderAt, s.ownersOverThreshold);
  const deadline = addDays(since, r.reminderGraceDays);
  return duty('reminders', today.getTime() <= deadline.getTime() ? 'due' : 'overdue', deadline, s.lastReminderAt, s.ownersOverThreshold);
}

function assemblyDuty(s: ComplianceSnapshot, today: Date, r: ComplianceRules): ComplianceDuty {
  // The assembly module arrives in sub-plan 2. Until a building has had one, domar knows nothing
  // about its assemblies and must not claim a breach it cannot evidence (plan addendum 5).
  if (s.assemblyCount === 0) return duty('assembly', 'n/a', null, null, 0);
  const held = parse(s.lastAssemblyHeldAt);
  if (held === null) return duty('assembly', 'due', null, s.lastAssemblyInvitedAt, s.assemblyCount);
  const deadline = addMonths(held, r.assemblyMaxAgeMonths);
  let status = windowStatus(deadline, addMonths(deadline, r.graceMonths), today);
  const invited = parse(s.lastAssemblyInvitedAt);
  // Art. 37: the invitation must go out at least 15 days before the assembly.
  if (status === 'ok' && invited !== null && wholeDaysBetween(invited, held) < r.assemblyInvitationMinDays) status = 'due';
  return duty('assembly', status, deadline, s.lastAssemblyHeldAt, s.assemblyCount);
}

function annualReportDuty(s: ComplianceSnapshot, today: Date, r: ComplianceRules): ComplianceDuty {
  const last = parse(s.lastAnnualReportAt);
  const deadline = addMonths(last ?? new Date(s.buildingCreatedAt), r.annualReportMaxAgeMonths);
  const graceEnd = addMonths(deadline, r.graceMonths);
  const status = windowStatus(deadline, graceEnd, today);
  // A building younger than a year owes no annual report yet; that is `n/a`, not a satisfied duty.
  if (last === null && status === 'ok') return duty('annual_report', 'n/a', deadline, null);
  return duty('annual_report', status, deadline, s.lastAnnualReportAt);
}

function fundTransparencyDuty(s: ComplianceSnapshot): ComplianceDuty {
  const ok = s.portalLinkedOwners > 0 && s.fundStatementAvailableAt !== null;
  // Never `overdue`: Art. 45(4) names a right, not a date.
  return duty('fund_transparency', ok ? 'ok' : 'due', null, s.fundStatementAvailableAt, s.portalLinkedOwners);
}

function fundAccountsDuty(s: ComplianceSnapshot): ComplianceDuty {
  const filled = (v: string | null) => v !== null && v.trim() !== '';
  // Not `due`: separate accounts are owed from the first day of the mandate, so a blank is a breach.
  return duty('fund_accounts', filled(s.regularFundAccount) && filled(s.reserveFundAccount) ? 'ok' : 'overdue', null, null);
}

function handoverDuty(s: ComplianceSnapshot, today: Date, r: ComplianceRules): ComplianceDuty {
  const endsOn = parse(s.managementContractEndsOn);
  if (endsOn === null) return duty('handover', 'n/a', null, s.lastHandoverReportAt);
  const deadline = addDays(endsOn, r.handoverDays);
  const issued = parse(s.lastHandoverReportAt);
  if (issued !== null && issued.getTime() >= endsOn.getTime()) return duty('handover', 'ok', deadline, s.lastHandoverReportAt);
  if (today.getTime() < endsOn.getTime()) return duty('handover', 'ok', deadline, null);
  return duty('handover', today.getTime() <= deadline.getTime() ? 'due' : 'overdue', deadline, null);
}

/**
 * Art. 47(5) is informational (spec §3): a distributed extraordinary cost is neither a duty met nor
 * a duty missed, it is a number the manager should be able to see.
 */
function extraordinaryDuty(s: ComplianceSnapshot): ComplianceDuty {
  return duty('extraordinary_costs', 'n/a', null, null, s.extraordinaryCostCount);
}

/**
 * Pure: the same snapshot, day and rules always give the same duties. `today` is local midnight in
 * the tenant's timezone (`localDayStart`), because every rule here is day- or month-grained.
 */
export function evaluateBuildingCompliance(snapshot: ComplianceSnapshot, today: Date, rules: ComplianceRules): ComplianceResult {
  const duties: ComplianceDuty[] = [
    invoicesDuty(snapshot, today, rules),
    remindersDuty(snapshot, today, rules),
    assemblyDuty(snapshot, today, rules),
    annualReportDuty(snapshot, today, rules),
    fundTransparencyDuty(snapshot),
    fundAccountsDuty(snapshot),
    handoverDuty(snapshot, today, rules),
    extraordinaryDuty(snapshot),
  ];
  const counts = { ok: 0, due: 0, overdue: 0, na: 0 };
  for (const d of duties) counts[d.status === 'n/a' ? 'na' : d.status] += 1;
  const status: ComplianceStatus = counts.overdue > 0 ? 'overdue' : counts.due > 0 ? 'due' : counts.ok > 0 ? 'ok' : 'n/a';
  return { status, duties, counts };
}
