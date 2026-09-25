import { type Db, schema } from '@domar/db';
import {
  buildAnnualReport, getCountryPack, yearWindow,
  type AnnualReportInput, type CountryCode, type CountryPack, type FundMovementIn,
  type ReportAssembly, type ReportExpense, type ReportFund, type ReportOwner, type ReportPostingKind,
} from '@domar/domain';
import { and, asc, count, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { badRequest } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { getBuilding } from '../buildings/repo.js';

const P = schema.postings; const E = schema.expenses; const S = schema.suppliers; const U = schema.units;
const C = schema.contacts; const R = schema.reminders; const AS = schema.assemblies; const AD = schema.assemblyDecisions;
const T = schema.tenants;

export type BuildingRow = Awaited<ReturnType<typeof getBuilding>>;
export type TenantRow = typeof T.$inferSelect;

/**
 * The tenant row and its pack, kept locally exactly as `resources/compliance/snapshot.ts` keeps one:
 * a report reads the pack for its legal sentences and its money format, nothing more.
 */
export async function tenantPack(db: Db, ctx: TenantContext) {
  const tenant = (await db.query.tenants.findFirst({ where: eq(T.id, ctx.tenantId) }))!;
  const pack = getCountryPack(tenant.countryCode as CountryCode);
  if (!pack) throw new Error(`unknown country pack: ${tenant.countryCode}`);
  return { tenant, pack };
}

/** Fund cash before the window opens. A fund with no history is 0, never absent (addendum 5). */
async function openingByFund(db: Db, ctx: TenantContext, buildingId: string, from: Date): Promise<Record<ReportFund, number>> {
  const rows = await db.select({ fund: P.fund, total: sql<string>`coalesce(sum(${P.amountMinor}), 0)` }).from(P)
    .where(and(eq(P.tenantId, ctx.tenantId), eq(P.buildingId, buildingId), eq(P.account, 'fund'), lt(P.bookedAt, from)))
    .groupBy(P.fund);
  const out: Record<ReportFund, number> = { regular: 0, reserve: 0 };
  for (const r of rows) out[r.fund as ReportFund] = Number(r.total);
  return out;
}

/**
 * Fund cash moved inside the window, grouped the way the report prints it. Inflow and outflow are
 * summed separately inside each group so the grouping is lossless even if a `(kind, refType)` pair
 * ever carries both signs (addendum 6).
 */
async function fundMovements(db: Db, ctx: TenantContext, buildingId: string, from: Date, to: Date): Promise<FundMovementIn[]> {
  const rows = await db.select({
    fund: P.fund, kind: P.kind, refType: P.refType,
    inflow: sql<string>`coalesce(sum(case when ${P.amountMinor} > 0 then ${P.amountMinor} else 0 end), 0)`,
    outflow: sql<string>`coalesce(sum(case when ${P.amountMinor} < 0 then -${P.amountMinor} else 0 end), 0)`,
  }).from(P)
    .where(and(eq(P.tenantId, ctx.tenantId), eq(P.buildingId, buildingId), eq(P.account, 'fund'), gte(P.bookedAt, from), lt(P.bookedAt, to)))
    .groupBy(P.fund, P.kind, P.refType);
  return rows.map((r) => ({
    fund: r.fund as ReportFund, kind: r.kind as ReportPostingKind, refType: r.refType,
    inflowMinor: Number(r.inflow), outflowMinor: Number(r.outflow),
  }));
}

/**
 * Expenses paid inside the window, with the supplier's name resolved. A void is read as of the end
 * of the window, not as of today: money spent in 2026 and reversed in 2027 was spent in 2026 and
 * stays in that year's report, which is the one already filed with the owners. The reversal lands in
 * the year that booked it, where its `expense_void` posting sits.
 */
async function windowExpenses(db: Db, ctx: TenantContext, buildingId: string, from: Date, to: Date, noSupplier: string): Promise<ReportExpense[]> {
  const rows = await db.select({ e: E, supplierName: S.name }).from(E)
    .leftJoin(S, and(eq(S.id, E.supplierId), eq(S.tenantId, E.tenantId)))
    .where(and(
      eq(E.tenantId, ctx.tenantId), eq(E.buildingId, buildingId),
      or(isNull(E.voidedAt), gte(E.voidedAt, to)),
      gte(E.paidAt, from), lt(E.paidAt, to),
    ))
    .orderBy(asc(E.paidAt), asc(E.id));
  return rows.map((r) => ({
    id: r.e.id, fund: r.e.fund as ReportFund, description: r.e.description,
    supplier: r.supplierName ?? r.e.supplierText ?? noSupplier,
    amountMinor: r.e.amountMinor, paidAt: r.e.paidAt.toISOString(),
    // The query keeps the rows voided after the window closed, and the flag says so as of `to`; the
    // builder — the one place that decides what a void means — does the excluding.
    voided: r.e.voidedAt !== null && r.e.voidedAt.getTime() < to.getTime(),
  }));
}

/**
 * Every owner of the building: what they were billed, what they paid, where they stand (addendum 7).
 * The set is today's owners *and* everybody the owner ledger of this building names up to the end of
 * the window — somebody who sold in June was still billed in May, and their debt, if they left one,
 * is still the building's. They are listed with no unit labels and `current: false`.
 */
async function reportOwners(db: Db, ctx: TenantContext, buildingId: string, from: Date, to: Date): Promise<ReportOwner[]> {
  const [units, booked] = await Promise.all([
    db.select({ ownerContactId: U.ownerContactId, label: U.label }).from(U)
      .where(and(eq(U.tenantId, ctx.tenantId), eq(U.buildingId, buildingId))),
    db.selectDistinct({ contactId: P.contactId }).from(P)
      .where(and(eq(P.tenantId, ctx.tenantId), eq(P.buildingId, buildingId), eq(P.account, 'owner'), isNotNull(P.contactId), lt(P.bookedAt, to))),
  ]);
  const labels = new Map<string, string[]>();
  for (const u of units) {
    if (!u.ownerContactId) continue;
    const list = labels.get(u.ownerContactId) ?? [];
    list.push(u.label);
    labels.set(u.ownerContactId, list);
  }
  const contactIds = [...new Set([...labels.keys(), ...booked.map((r) => r.contactId!)])];
  if (contactIds.length === 0) return [];
  const owned = and(eq(P.tenantId, ctx.tenantId), eq(P.buildingId, buildingId), eq(P.account, 'owner'), inArray(P.contactId, contactIds));
  const [contacts, inWindow, atEnd] = await Promise.all([
    db.select({ id: C.id, firstName: C.firstName, lastName: C.lastName }).from(C)
      .where(and(eq(C.tenantId, ctx.tenantId), inArray(C.id, contactIds))),
    db.select({
      contactId: P.contactId,
      billed: sql<string>`coalesce(sum(case when ${P.kind} = 'charge' then ${P.amountMinor} else 0 end), 0)`,
      // A payment posts a negative to the owner and its void posts the same amount back, so negating
      // both ref types nets a voided payment to exactly zero collected.
      collected: sql<string>`coalesce(-sum(case when ${P.refType} in ('payment', 'payment_void') then ${P.amountMinor} else 0 end), 0)`,
    }).from(P).where(and(owned, gte(P.bookedAt, from), lt(P.bookedAt, to))).groupBy(P.contactId),
    db.select({ contactId: P.contactId, total: sql<string>`coalesce(sum(${P.amountMinor}), 0)` })
      .from(P).where(and(owned, lt(P.bookedAt, to))).groupBy(P.contactId),
  ]);
  const billed = new Map(inWindow.map((r) => [r.contactId!, Number(r.billed)]));
  const collected = new Map(inWindow.map((r) => [r.contactId!, Number(r.collected)]));
  const balance = new Map(atEnd.map((r) => [r.contactId!, Number(r.total)]));
  return contacts.map((c) => ({
    contactId: c.id,
    name: `${c.firstName} ${c.lastName}`.trim(),
    unitLabels: (labels.get(c.id) ?? []).slice().sort((x, y) => x.localeCompare(y)),
    current: labels.has(c.id),
    billedMinor: billed.get(c.id) ?? 0,
    collectedMinor: collected.get(c.id) ?? 0,
    balanceMinor: balance.get(c.id) ?? 0,
  }));
}

/**
 * Art. 28 reminders that actually reached an owner in the window. `coalesce(sent_at, created_at)` is
 * the same expression `priorRemindersByOwner` reads: a letter counts in the year it went out —
 * marking one printed stamps `sent_at` too — and a row with no `sent_at` falls back to the day it
 * was created, so every reminder is counted once and in exactly one year.
 */
async function remindersSent(db: Db, ctx: TenantContext, buildingId: string, from: Date, to: Date): Promise<number> {
  const [row] = await db.select({ n: count() }).from(R).where(and(
    eq(R.tenantId, ctx.tenantId), eq(R.buildingId, buildingId), inArray(R.status, ['sent', 'printed']),
    sql`coalesce(${R.sentAt}, ${R.createdAt}) >= ${from.toISOString()}::timestamptz`,
    sql`coalesce(${R.sentAt}, ${R.createdAt}) < ${to.toISOString()}::timestamptz`,
  ));
  return Number(row?.n ?? 0);
}

/** Art. 37 assemblies actually held in the window, oldest first, with how much each decided. */
async function assembliesHeld(db: Db, ctx: TenantContext, buildingId: string, from: Date, to: Date): Promise<ReportAssembly[]> {
  // "assemblies"."id" is hard-coded for the same reason as in resources/assemblies/repo.ts: drizzle
  // renders single-table select columns unqualified inside raw sql, so a bare `id` would bind wrong.
  const rows = await db.select({
    heldAt: AS.heldAt,
    decisionCount: sql<number>`(select count(*) from ${AD} d where d.assembly_id = "assemblies"."id" and d.tenant_id = ${ctx.tenantId})`.mapWith(Number),
  }).from(AS)
    .where(and(eq(AS.tenantId, ctx.tenantId), eq(AS.buildingId, buildingId), eq(AS.status, 'held'), gte(AS.heldAt, from), lt(AS.heldAt, to)))
    .orderBy(asc(AS.heldAt));
  return rows.map((r) => ({ heldAt: r.heldAt!.toISOString(), decisionCount: r.decisionCount }));
}

/** Everything both reports read. Task 3's handover calls it with its own window and nothing else. */
export async function collectReportInput(
  db: Db, ctx: TenantContext, building: BuildingRow, tenant: TenantRow, pack: CountryPack,
  year: number, from: Date, to: Date,
): Promise<AnnualReportInput> {
  const [opening, movements, expenses, owners, reminders, assemblies, [units]] = await Promise.all([
    openingByFund(db, ctx, building.id, from),
    fundMovements(db, ctx, building.id, from, to),
    windowExpenses(db, ctx, building.id, from, to, pack.labels.reports.noSupplier),
    reportOwners(db, ctx, building.id, from, to),
    remindersSent(db, ctx, building.id, from, to),
    assembliesHeld(db, ctx, building.id, from, to),
    db.select({ n: count() }).from(U).where(and(eq(U.tenantId, ctx.tenantId), eq(U.buildingId, building.id))),
  ]);
  return {
    year,
    window: { from: from.toISOString(), to: to.toISOString() },
    building: {
      name: building.name, address: building.address, city: building.city, postalCode: building.postalCode,
      unitCount: Number(units?.n ?? 0),
    },
    manager: { name: tenant.name, companyNumber: tenant.companyNumber },
    opening,
    fundMovements: movements,
    expenses,
    owners,
    remindersSent: reminders,
    assemblies,
  };
}

/** Art. 31 for one building and one civil year of the tenant's zone (addendum 8). */
export async function annualReport(db: Db, ctx: TenantContext, buildingId: string, year: number) {
  const building = await getBuilding(db, ctx, buildingId); // 404 across tenants
  const { tenant, pack } = await tenantPack(db, ctx);
  // A year that has not happened cannot be reported on: the figures would read as a full year of
  // nothing. The bound is the tenant's civil year, the same grain the window itself is cut in.
  const thisYear = Number(new Intl.DateTimeFormat('en-CA', { timeZone: tenant.timezone, year: 'numeric' }).format(new Date()));
  if (year > thisYear) throw badRequest('year_in_the_future', `The year ${year} has not begun yet`);
  const { from, to } = yearWindow(year, tenant.timezone);
  const input = await collectReportInput(db, ctx, building, tenant, pack, year, from, to);
  return { building, tenant, pack, from, to, data: buildAnnualReport(input) };
}
