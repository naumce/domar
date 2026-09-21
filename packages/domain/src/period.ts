const PERIOD_RE = /^[1-9]\d{3}-(0[1-9]|1[0-2])$/;

export function isValidPeriod(p: string): boolean {
  return PERIOD_RE.test(p);
}

function parts(p: string): [number, number] {
  if (!isValidPeriod(p)) throw new RangeError(`invalid period: ${p}`);
  return [Number(p.slice(0, 4)), Number(p.slice(5, 7))];
}

export function comparePeriods(a: string, b: string): number {
  return monthsBetween(b, a);
}

/** to − from, in whole months. */
export function monthsBetween(from: string, to: string): number {
  const [fy, fm] = parts(from);
  const [ty, tm] = parts(to);
  return (ty - fy) * 12 + (tm - fm);
}

export function nextPeriod(p: string): string {
  const [y, m] = parts(p);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

/** The IANA zone's offset (local minus UTC, in ms) at the given instant. */
function zoneOffsetAt(instantMs: number, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const local = fmt.formatToParts(new Date(instantMs));
  const get = (t: string) => Number(local.find((x) => x.type === t)!.value);
  const localAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return localAsUtc - instantMs;
}

/**
 * UTC instant of local midnight on the first day of the period in the given IANA zone.
 * Resolves the offset in two passes: the first pass's offset (taken at the UTC-midnight
 * guess) can be the wrong side of a DST transition, so a second pass re-reads the offset
 * at the resulting candidate instant, which is accurate except within the transition's own
 * few-hour window (irrelevant here since months never start there).
 */
export function periodStartDate(p: string, timeZone: string): Date {
  const [y, m] = parts(p);
  const guess = Date.UTC(y, m - 1, 1, 0, 0, 0);
  const offset = zoneOffsetAt(guess, timeZone);
  const candidate = guess - offset;
  const offset2 = zoneOffsetAt(candidate, timeZone);
  return new Date(guess - offset2);
}

export interface RecurrenceRule {
  frequency: 'monthly' | 'every_n_months';
  intervalMonths: number;
  startsPeriod: string;
  endsPeriod: string | null;
}

export function isServiceDue(period: string, rule: RecurrenceRule): boolean {
  if (comparePeriods(period, rule.startsPeriod) < 0) return false;
  if (rule.endsPeriod && comparePeriods(period, rule.endsPeriod) > 0) return false;
  if (rule.frequency === 'monthly') return true;
  // intervalMonths ≥ 2 is enforced by the API; floor at 1 here so an out-of-range value degrades to monthly.
  const interval = Math.max(1, Math.trunc(rule.intervalMonths));
  return monthsBetween(rule.startsPeriod, period) % interval === 0;
}
