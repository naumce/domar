import { type Db, schema } from '@domar/db';
import {
  buildJournal, civilDayStart, JournalError, type Journal, type JournalExpenseIn, type JournalInput,
  type JournalInvoiceIn, type JournalLineKind, type JournalPostingIn,
} from '@domar/domain';
import { and, asc, eq, gte, inArray, lt, or } from 'drizzle-orm';
import { AppError, badRequest } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { getBuilding } from '../buildings/repo.js';
import { tenantPack } from '../reports/data.js';
import { requireChart } from './chart.js';

const P = schema.postings; const B = schema.buildings; const C = schema.contacts;
const INV = schema.invoices; const IL = schema.invoiceLines;
const E = schema.expenses; const S = schema.suppliers; const AC = schema.accountCodes;
const AP = schema.accountingPeriods;

export interface AccountingWindow {
  from: Date;
  to: Date;
  buildingId?: string | undefined;
}

/** A civil day of the tenant's zone, never UTC — the same helper `resources/reports/data.ts` uses. */
function dayIn(timeZone: string): (x: Date) => string {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return (x) => fmt.format(x);
}

/**
 * Every ledger row the file reports, in two sets that cannot overlap (spec §5):
 *  - the window's own movements, `booked_at` inside it;
 *  - the late arrivals, `booked_at` **before** it and `created_at` inside it. Closing a period
 *    refuses nothing, so a September payment entered in October is recordable — and this is where it
 *    resurfaces, in its own section, with the day it really arrived and the period it belongs to.
 *
 * Fixed query cost: one `postings` scan plus, at most, four batched lookups keyed by the ids that
 * scan turns up (`inArray`, never per-row) — six queries whether the window holds one posting or ten
 * thousand, so a year's worth of invoices never triggers an N+1.
 */
export async function collectJournalInput(db: Db, ctx: TenantContext, w: AccountingWindow): Promise<JournalInput> {
  if (w.to.getTime() <= w.from.getTime()) throw badRequest('invalid_window', 'The window must end after it starts');
  const [chart, { tenant }] = await Promise.all([requireChart(db, ctx), tenantPack(db, ctx)]);
  if (w.buildingId) await getBuilding(db, ctx, w.buildingId); // 404 across tenants

  // `w.from`/`w.to` carry only the calendar date (see routes.ts's `windowOf`); the instants the
  // window actually opens and closes at are the tenant's own civil midnight, not UTC midnight.
  const from = civilDayStart(w.from.toISOString().slice(0, 10), tenant.timezone);
  const to = civilDayStart(w.to.toISOString().slice(0, 10), tenant.timezone);

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

  const postings: JournalPostingIn[] = rows.map((r) => ({
    id: r.p.id, account: r.p.account, fund: r.p.fund, kind: r.p.kind,
    amountMinor: r.p.amountMinor, refType: r.p.refType, refId: r.p.refId,
    period: r.p.period ?? day(r.p.bookedAt).slice(0, 7),
    date: day(r.p.bookedAt),
    buildingName: r.buildingName,
    counterparty: `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim(),
    prior: r.p.bookedAt.getTime() < from.getTime(),
  }));

  const invoiceIds = [...new Set(postings.filter((p) => p.refType === 'invoice' && p.refId).map((p) => p.refId!))];
  const expenseIds = [...new Set(postings.filter((p) => (p.refType === 'expense' || p.refType === 'expense_void') && p.refId).map((p) => p.refId!))];
  const periods = [...new Set(postings.map((p) => p.period))];

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
    periods.length
      ? db.select({ period: AP.period }).from(AP).where(and(eq(AP.tenantId, ctx.tenantId), inArray(AP.period, periods)))
      : [],
  ]);

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

/**
 * The one entry point the preview, the export and the period close all share, so the three can never
 * disagree about what a month contains. A derivation failure is an API error the screen can read.
 */
export async function buildJournalFor(db: Db, ctx: TenantContext, w: AccountingWindow): Promise<{ journal: Journal; buildingName: string | null; tenantName: string }> {
  const [input, { tenant }] = await Promise.all([collectJournalInput(db, ctx, w), tenantPack(db, ctx)]);
  const buildingName = w.buildingId ? (await getBuilding(db, ctx, w.buildingId)).name : null;
  try {
    return { journal: buildJournal(input), buildingName, tenantName: tenant.name };
  } catch (err) {
    if (err instanceof JournalError) throw new AppError(409, err.code, err.message, err.details);
    throw err;
  }
}
