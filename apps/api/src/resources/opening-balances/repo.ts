import { type Db, schema } from '@domar/db';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { writeAudit } from '../../audit.js';
import { badRequest, conflict } from '../../errors.js';
import { addPosting, ownerBalancesByFund } from '../../ledger.js';
import type { TenantContext } from '../../tenant-context.js';
import { getBuilding } from '../buildings/repo.js';
import { dedupe } from '../common.js';
import type { OpeningBalanceCreate, OpeningBalanceRow } from './schema.js';

const BP = schema.billingPeriods; const C = schema.contacts; const U = schema.units;

type InsertedOpening = { id: string; contactId: string; fund: 'regular' | 'reserve'; amountMinor: number; bookedAt: Date; note: string | null };

/** True when the building already has a published period, i.e. opening balances would rewrite history. */
export async function hasPublishedPeriod(db: Db, ctx: TenantContext, buildingId: string): Promise<boolean> {
  const row = await db.query.billingPeriods.findFirst({
    where: and(eq(BP.tenantId, ctx.tenantId), eq(BP.buildingId, buildingId), eq(BP.status, 'published')),
    columns: { id: true },
  });
  return row !== undefined;
}

/**
 * Books one owner `opening` posting per row. Runs inside the caller's transaction: no audit row,
 * no published-period guard, no building lookup — `addOpeningBalances` and the CSV import do those.
 */
export async function insertOpeningBalances(tx: Db, ctx: TenantContext, buildingId: string, rows: OpeningBalanceRow[]): Promise<InsertedOpening[]> {
  const contactIds = dedupe(rows.map((r) => r.contactId));
  const known = new Set((await tx.query.contacts.findMany({
    where: and(eq(C.tenantId, ctx.tenantId), inArray(C.id, contactIds)), columns: { id: true },
  })).map((c) => c.id));
  const missing = contactIds.find((id) => !known.has(id));
  if (missing) throw badRequest('invalid_reference', `contactId ${missing} does not belong to this organization`);

  const now = new Date();
  const out: InsertedOpening[] = [];
  for (const r of rows) {
    const posting = await addPosting(tx, ctx, {
      buildingId, account: 'owner', contactId: r.contactId, fund: r.fund, kind: 'opening',
      amountMinor: r.amountMinor, refType: 'opening_balance',
      bookedAt: r.bookedAt ? new Date(r.bookedAt) : now,
    });
    out.push({ id: posting.id, contactId: r.contactId, fund: r.fund, amountMinor: r.amountMinor, bookedAt: posting.bookedAt, note: r.note ?? null });
  }
  return out;
}

export async function addOpeningBalances(db: Db, ctx: TenantContext, buildingId: string, input: OpeningBalanceCreate) {
  return db.transaction(async (tx) => {
    await getBuilding(tx, ctx, buildingId);
    const published = await hasPublishedPeriod(tx, ctx, buildingId);
    if (published && !input.force) throw conflict('period_published', 'This building already has a published period; resend with force: true to book anyway');
    const postings = await insertOpeningBalances(tx, ctx, buildingId, input.rows);
    await writeAudit(tx, ctx, {
      action: 'opening_balance.create', entityType: 'building', entityId: buildingId,
      after: { count: postings.length, totalMinor: postings.reduce((a, p) => a + p.amountMinor, 0), force: input.force, afterPublishedPeriod: published, rows: postings },
    });
    return { created: postings.length, postings };
  });
}

/** Unit owners of the building with their current owner balance per fund. */
export async function listOpeningBalances(db: Db, ctx: TenantContext, buildingId: string) {
  await getBuilding(db, ctx, buildingId);
  const owners = await db
    .selectDistinct({ id: C.id, firstName: C.firstName, lastName: C.lastName })
    .from(U)
    .innerJoin(C, and(eq(C.id, U.ownerContactId), eq(C.tenantId, ctx.tenantId)))
    .where(and(eq(U.tenantId, ctx.tenantId), eq(U.buildingId, buildingId)))
    .orderBy(asc(C.lastName), asc(C.firstName));
  const balances = await ownerBalancesByFund(db, ctx, buildingId);
  const rows = owners.map((o) => {
    const b = balances[o.id] ?? { regularMinor: 0, reserveMinor: 0, openingMinor: 0 };
    return {
      contactId: o.id, firstName: o.firstName, lastName: o.lastName,
      regularMinor: b.regularMinor, reserveMinor: b.reserveMinor, balanceMinor: b.regularMinor + b.reserveMinor, openingMinor: b.openingMinor,
    };
  });
  return { rows, hasPublishedPeriod: await hasPublishedPeriod(db, ctx, buildingId) };
}
