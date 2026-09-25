import { type Db, schema } from '@domar/db';
import {
  buildJournal, type Chart, civilDayStart, JournalError, type Journal, type JournalExpenseIn, type JournalInput,
  type JournalInvoiceIn, type JournalLineKind, type JournalPostingIn,
} from '@domar/domain';
import { and, asc, eq, gte, inArray, lt, or } from 'drizzle-orm';
import { AppError, badRequest } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { getBuilding } from '../buildings/repo.js';
import { dayIn } from '../common.js';
import { tenantPack, type BuildingRow, type TenantRow } from '../reports/data.js';
import { requireChart } from './chart.js';

const P = schema.postings; const B = schema.buildings; const C = schema.contacts;
const INV = schema.invoices; const IL = schema.invoiceLines;
const E = schema.expenses; const S = schema.suppliers; const AC = schema.accountCodes;
const AP = schema.accountingPeriods;

/**
 * The whole zip is built in memory (controller ruling, Task 5 review): nothing capped how long a
 * window could be, so a multi-year tenant-wide export on a large tenant could exhaust it. 366 days —
 * a full calendar year, leap included — is the largest grain the product already reasons in
 * (`yearWindow` in `@domar/domain` cuts the annual report the same way), so a legitimate preview,
 * export or close never needs more than this without also needing to split by year regardless. Lives
 * here rather than on the two request schemas (fix round 1, item 4): `resolveWindow` is the one
 * chokepoint every window-taking caller passes through, request or internal, so this is where the
 * memory it's guarding against is actually spent.
 */
const MAX_WINDOW_DAYS = 366;

export interface AccountingWindow {
  /** `YYYY-MM-DD`, a civil day in the tenant's own zone — resolved to an instant only once the
   * tenant's timezone is known (see `resolveWindow`), never by reinterpreting a UTC instant. */
  from: string;
  /** `YYYY-MM-DD`, exclusive, same zone as `from`. */
  to: string;
  buildingId?: string | undefined;
}

/**
 * Everything a window's derivation needs before it can touch `postings`: the chart (or a 409 naming
 * what's unmapped), the tenant (for its zone and name), and the building (or a 404 across tenants) —
 * fetched exactly once per request, whichever of `collectJournalInput`/`buildJournalFor` is called.
 */
async function resolveWindow(db: Db, ctx: TenantContext, w: AccountingWindow): Promise<{ chart: Chart; tenant: TenantRow; building: BuildingRow | null }> {
  // Plain string comparison: `YYYY-MM-DD` sorts exactly like the dates it spells, so this needs
  // neither the tenant's zone nor a database round trip to catch a window that ends before it starts.
  if (w.to <= w.from) throw badRequest('invalid_window', 'The window must end after it starts');
  // Calendar-day arithmetic on the UTC reading of the two dates: close enough to bound memory (a
  // DST day is at most an hour off either way) without needing the tenant's zone, which isn't known
  // until the query below.
  const spanDays = (Date.parse(`${w.to}T00:00:00Z`) - Date.parse(`${w.from}T00:00:00Z`)) / 86_400_000;
  if (spanDays > MAX_WINDOW_DAYS) throw badRequest('window_too_long', `The window must not exceed ${MAX_WINDOW_DAYS} days`);
  const [chart, { tenant }] = await Promise.all([requireChart(db, ctx), tenantPack(db, ctx)]);
  const building = w.buildingId ? await getBuilding(db, ctx, w.buildingId) : null; // 404 across tenants
  return { chart, tenant, building };
}

/**
 * Every ledger row the file reports, in two sets that cannot overlap (spec §5):
 *  - the window's own movements, `booked_at` inside it, not yet overtaken by their own period's close;
 *  - the late arrivals: `booked_at` **before** the window with `created_at` inside it (a September
 *    payment entered in October), or `booked_at` inside the window but `created_at` after that
 *    period's own `closed_at` (a September payment entered *after September itself was closed*, fix
 *    round 1 item 1 — the case Task 4's rule missed, because a posting still dated inside the month
 *    it belongs to was never treated as "late" at all). Closing a period refuses nothing, so both are
 *    recordable — and this is where they resurface, in their own section, with the period they
 *    actually belong to.
 *
 * Fixed query cost: one `postings` scan plus, at most, four batched lookups keyed by the ids that
 * scan turns up (`inArray`, never per-row) — six queries whether the window holds one posting or ten
 * thousand, so a year's worth of invoices never triggers an N+1.
 */
async function collectFrom(db: Db, ctx: TenantContext, w: AccountingWindow, chart: Chart, tenant: TenantRow): Promise<JournalInput> {
  // `w.from`/`w.to` are civil days of the tenant's own zone; resolved to instants here, in the one
  // place that knows the timezone, rather than by reinterpreting a UTC-anchored `Date`.
  const from = civilDayStart(w.from, tenant.timezone);
  const to = civilDayStart(w.to, tenant.timezone);

  const day = dayIn(tenant.timezone);
  const rows = await db.select({
    p: P, buildingName: B.name, firstName: C.firstName, lastName: C.lastName,
  }).from(P)
    .innerJoin(B, and(eq(B.id, P.buildingId), eq(B.tenantId, P.tenantId)))
    .leftJoin(C, and(eq(C.id, P.contactId), eq(C.tenantId, P.tenantId)))
    .where(and(
      eq(P.tenantId, ctx.tenantId),
      ...(w.buildingId ? [eq(P.buildingId, w.buildingId)] : []),
      or(
        and(gte(P.bookedAt, from), lt(P.bookedAt, to)),
        and(lt(P.bookedAt, from), gte(P.createdAt, from), lt(P.createdAt, to)),
      ),
    ))
    .orderBy(asc(P.bookedAt), asc(P.createdAt), asc(P.id));

  const periodOf = (r: (typeof rows)[number]) => r.p.period ?? day(r.p.bookedAt).slice(0, 7);
  const invoiceIds = [...new Set(rows.filter((r) => r.p.refType === 'invoice' && r.p.refId).map((r) => r.p.refId!))];
  const expenseIds = [...new Set(rows.filter((r) => (r.p.refType === 'expense' || r.p.refType === 'expense_void') && r.p.refId).map((r) => r.p.refId!))];
  const periods = [...new Set(rows.map(periodOf))];

  const [invoiceRows, lineRows, expenseRows, closedRows] = await Promise.all([
    invoiceIds.length
      ? db.select({ id: INV.id, number: INV.number }).from(INV).where(and(eq(INV.tenantId, ctx.tenantId), inArray(INV.id, invoiceIds)))
      : [],
    invoiceIds.length
      ? db.select({ invoiceId: IL.invoiceId, kind: IL.kind, net: IL.ownerNetMinor, tax: IL.ownerTaxMinor, gross: IL.ownerGrossMinor })
        .from(IL).where(and(eq(IL.tenantId, ctx.tenantId), inArray(IL.invoiceId, invoiceIds))).orderBy(asc(IL.invoiceId), asc(IL.sortOrder))
      : [],
    expenseIds.length
      ? db.select({ id: E.id, description: E.description, code: AC.code, name: AC.name }).from(E)
        .leftJoin(S, and(eq(S.id, E.supplierId), eq(S.tenantId, E.tenantId)))
        .leftJoin(AC, and(eq(AC.id, S.accountCodeId), eq(AC.tenantId, E.tenantId), eq(AC.isActive, true)))
        .where(and(eq(E.tenantId, ctx.tenantId), inArray(E.id, expenseIds)))
      : [],
    // Its own `closed_at`, not just whether it's closed: a posting is a late arrival only if it was
    // created *after* the moment its own period was closed, not merely inside a period that happens
    // to be closed now (fix round 1, item 1).
    periods.length
      ? db.select({ period: AP.period, closedAt: AP.closedAt }).from(AP).where(and(eq(AP.tenantId, ctx.tenantId), inArray(AP.period, periods)))
      : [],
  ]);

  const closedAtByPeriod = new Map(closedRows.map((r) => [r.period, r.closedAt]));
  const postings: JournalPostingIn[] = rows.map((r) => {
    const period = periodOf(r);
    const closedAt = closedAtByPeriod.get(period);
    const bookedBeforeWindow = r.p.bookedAt.getTime() < from.getTime();
    // Not gated to this window's own bounds: closing refuses an unended period (fix round 1, item 1,
    // part one), so `closedAt` is always in the month *after* the one it closes, and anything created
    // later still is later again — meaning the window containing `createdAt` is never the closed
    // period's own window. This posting is still fetched for the closed period's own window whenever
    // that window is re-derived (its `bookedAt` puts it there), and belongs there as an adjustment
    // too — a re-run of an already-closed month re-showing what arrived after it closed is exactly
    // the point, same as this same posting also showing as an adjustment when `createdAt`'s own
    // window is queried, via `bookedBeforeWindow` below.
    const arrivedAfterOwnPeriodClosed = closedAt !== undefined && r.p.createdAt.getTime() > closedAt.getTime();
    return {
      id: r.p.id, account: r.p.account, fund: r.p.fund, kind: r.p.kind,
      amountMinor: r.p.amountMinor, refType: r.p.refType, refId: r.p.refId,
      period, date: day(r.p.bookedAt),
      buildingName: r.buildingName,
      counterparty: `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim(),
      prior: bookedBeforeWindow || arrivedAfterOwnPeriodClosed,
    };
  });

  const draft = new Map<string, { number: string; lines: { kind: JournalLineKind; ownerNetMinor: number; ownerTaxMinor: number; ownerGrossMinor: number }[] }>();
  for (const i of invoiceRows) draft.set(i.id, { number: i.number ?? '', lines: [] });
  for (const l of lineRows) draft.get(l.invoiceId)?.lines.push({ kind: l.kind as JournalLineKind, ownerNetMinor: l.net, ownerTaxMinor: l.tax, ownerGrossMinor: l.gross });
  const invoices: Record<string, JournalInvoiceIn> = Object.fromEntries(draft);

  const expenses: Record<string, JournalExpenseIn> = {};
  for (const e of expenseRows) {
    expenses[e.id] = { description: e.description, account: e.code !== null && e.name !== null ? { code: e.code, name: e.name } : null };
  }

  return { chart, postings, invoices, expenses, closedPeriods: closedRows.map((r) => r.period) };
}

export async function collectJournalInput(db: Db, ctx: TenantContext, w: AccountingWindow): Promise<JournalInput> {
  const { chart, tenant } = await resolveWindow(db, ctx, w);
  return collectFrom(db, ctx, w, chart, tenant);
}

/**
 * The one entry point the preview, the export and the period close all share, so the three can never
 * disagree about what a month contains. A derivation failure is an API error the screen can read.
 * Returns the chart it actually read (fix round 1, item 5): a caller that wants to print the chart —
 * the README does — must print *this* one rather than reading it again outside the transaction, where
 * a concurrent chart write could hand it a chart the journal never used. It also saves two redundant
 * queries a second `requireChart`/`tenantPack` call would otherwise cost.
 */
export async function buildJournalFor(
  db: Db, ctx: TenantContext, w: AccountingWindow, log: { error(obj: unknown, msg: string): void },
): Promise<{ journal: Journal; buildingName: string | null; tenantName: string; chart: Chart; timeZone: string }> {
  const { chart, tenant, building } = await resolveWindow(db, ctx, w);
  const input = await collectFrom(db, ctx, w, chart, tenant);
  try {
    return { journal: buildJournal(input), buildingName: building?.name ?? null, tenantName: tenant.name, chart, timeZone: tenant.timezone };
  } catch (err) {
    if (err instanceof JournalError) {
      // `chart_incomplete` never reaches here — it's thrown earlier, before `buildJournal` runs, and
      // it's a manager's problem (a slot they can map). These three codes mean the derivation's own
      // double-entry invariant failed on data the app itself wrote; no UI action fixes that, so it's
      // logged for an engineer to trace the posting. The client answer is unchanged: a 409.
      log.error({ code: err.code, details: err.details }, err.message);
      throw new AppError(409, err.code, err.message, err.details);
    }
    throw err;
  }
}
