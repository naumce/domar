import { type Db, schema } from '@domar/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { TenantContext } from './tenant-context.js';

const P = schema.postings;
export type Fund = 'regular' | 'reserve';
export type PostingKind = 'charge' | 'payment' | 'expense' | 'adjustment' | 'opening';

export interface NewPosting {
  buildingId: string;
  account: 'owner' | 'fund';
  fund: Fund;
  contactId?: string | null | undefined;
  kind: PostingKind;
  amountMinor: number;
  refType: string;
  refId?: string | null | undefined;
  period?: string | null | undefined;
  bookedAt?: Date | undefined;
}

export async function addPosting(db: Db, ctx: TenantContext, p: NewPosting) {
  const [row] = await db.insert(P).values({
    tenantId: ctx.tenantId, buildingId: p.buildingId, account: p.account, fund: p.fund, contactId: p.contactId ?? null, kind: p.kind,
    amountMinor: p.amountMinor, refType: p.refType, refId: p.refId ?? null, period: p.period ?? null, bookedAt: p.bookedAt ?? new Date(),
  }).returning();
  return row!;
}

export async function addPostings(db: Db, ctx: TenantContext, ps: NewPosting[]) {
  if (ps.length === 0) return;
  await db.insert(P).values(ps.map((p) => ({
    tenantId: ctx.tenantId, buildingId: p.buildingId, account: p.account, fund: p.fund, contactId: p.contactId ?? null, kind: p.kind,
    amountMinor: p.amountMinor, refType: p.refType, refId: p.refId ?? null, period: p.period ?? null, bookedAt: p.bookedAt ?? new Date(),
  })));
}

const sum = sql<string>`coalesce(sum(${P.amountMinor}), 0)`;

/** Outstanding balance of an owner in a building (positive = owes). */
export async function ownerBalance(db: Db, ctx: TenantContext, buildingId: string, contactId: string): Promise<number> {
  const [r] = await db.select({ total: sum }).from(P).where(and(eq(P.tenantId, ctx.tenantId), eq(P.buildingId, buildingId), eq(P.account, 'owner'), eq(P.contactId, contactId)));
  return Number(r?.total ?? 0);
}

/** Outstanding balances of all owners in a building, keyed by contactId. */
export async function ownerBalances(db: Db, ctx: TenantContext, buildingId: string): Promise<Record<string, number>> {
  const rows = await db.select({ contactId: P.contactId, total: sum }).from(P).where(and(eq(P.tenantId, ctx.tenantId), eq(P.buildingId, buildingId), eq(P.account, 'owner'))).groupBy(P.contactId);
  return Object.fromEntries(rows.filter((r) => r.contactId).map((r) => [r.contactId!, Number(r.total)]));
}

/** Cash balance of a building fund. */
export async function fundBalance(db: Db, ctx: TenantContext, buildingId: string, fund: Fund): Promise<number> {
  const [r] = await db.select({ total: sum }).from(P).where(and(eq(P.tenantId, ctx.tenantId), eq(P.buildingId, buildingId), eq(P.account, 'fund'), eq(P.fund, fund)));
  return Number(r?.total ?? 0);
}

/** Σ owner charges for a fund (what has been billed to owners). */
export async function billedToOwners(db: Db, ctx: TenantContext, buildingId: string, fund: Fund): Promise<number> {
  const [r] = await db.select({ total: sum }).from(P).where(and(eq(P.tenantId, ctx.tenantId), eq(P.buildingId, buildingId), eq(P.account, 'owner'), eq(P.fund, fund), eq(P.kind, 'charge')));
  return Number(r?.total ?? 0);
}

export async function deletePostingsByRef(db: Db, ctx: TenantContext, refType: string, refIds: string[]) {
  if (refIds.length === 0) return;
  await db.delete(P).where(and(eq(P.tenantId, ctx.tenantId), eq(P.refType, refType), inArray(P.refId, refIds)));
}
