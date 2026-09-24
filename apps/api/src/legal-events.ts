import { type Db, schema } from '@domar/db';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import type { TenantContext } from './tenant-context.js';

const LE = schema.legalEvents;

export type LegalEventKind = (typeof schema.legalEventKind.enumValues)[number];
export type LegalEventRow = typeof LE.$inferSelect;

export interface NewLegalEvent {
  buildingId: string;
  kind: LegalEventKind;
  refType: string;
  refId?: string | null | undefined;
  occurredAt?: Date | undefined;
  dueAt?: Date | null | undefined;
  /** Shapes per kind are in the plan's design addendum 2; always an object, never a scalar. */
  evidence: Record<string, unknown>;
}

/**
 * Spec §11: legal events are append-only. This module exports one writer, one conditional writer and
 * three readers — there is deliberately no update and no delete, and no route mutates the table.
 * Always called with the caller's transaction, so the event and the audit row commit together.
 */
export async function recordLegalEvent(tx: Db, ctx: TenantContext, e: NewLegalEvent): Promise<LegalEventRow> {
  const [row] = await tx.insert(LE).values({
    tenantId: ctx.tenantId,
    buildingId: e.buildingId,
    kind: e.kind,
    refType: e.refType,
    refId: e.refId ?? null,
    occurredAt: e.occurredAt ?? new Date(),
    dueAt: e.dueAt ?? null,
    evidence: e.evidence,
    createdBy: ctx.userId,
  }).returning();
  return row!;
}

/**
 * Art. 45(4) is "once per building": the first owner to link makes the fund statement available.
 * Two concurrent transactions (two owners registering at once) would otherwise both pass the select
 * before either commits; the advisory lock serialises them on (tenant, building, kind) so the second
 * transaction blocks until the first commits, then re-reads under READ COMMITTED and sees its row.
 */
export async function recordLegalEventOnce(tx: Db, ctx: TenantContext, e: NewLegalEvent): Promise<LegalEventRow | null> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${ctx.tenantId}:${e.buildingId}:${e.kind}`}))`);
  const [existing] = await tx.select({ id: LE.id }).from(LE)
    .where(and(eq(LE.tenantId, ctx.tenantId), eq(LE.buildingId, e.buildingId), eq(LE.kind, e.kind))).limit(1);
  if (existing) return null;
  return recordLegalEvent(tx, ctx, e);
}

/** When the building last did this, or null. */
export async function lastEventAt(db: Db, ctx: TenantContext, buildingId: string, kind: LegalEventKind): Promise<Date | null> {
  const [row] = await db.select({ occurredAt: LE.occurredAt }).from(LE)
    .where(and(eq(LE.tenantId, ctx.tenantId), eq(LE.buildingId, buildingId), eq(LE.kind, kind)))
    .orderBy(desc(LE.occurredAt)).limit(1);
  return row?.occurredAt ?? null;
}

export async function countEvents(db: Db, ctx: TenantContext, buildingId: string, kind: LegalEventKind): Promise<number> {
  const [row] = await db.select({ n: count() }).from(LE)
    .where(and(eq(LE.tenantId, ctx.tenantId), eq(LE.buildingId, buildingId), eq(LE.kind, kind)));
  return Number(row?.n ?? 0);
}

export async function listLegalEvents(db: Db, ctx: TenantContext, buildingId: string, q: { page: number; pageSize: number }) {
  const where = and(eq(LE.tenantId, ctx.tenantId), eq(LE.buildingId, buildingId));
  const [rows, [total]] = await Promise.all([
    db.select().from(LE).where(where).orderBy(desc(LE.occurredAt), desc(LE.createdAt), desc(LE.id))
      .limit(q.pageSize).offset((q.page - 1) * q.pageSize),
    db.select({ n: count() }).from(LE).where(where),
  ]);
  return { rows, total: Number(total?.n ?? 0) };
}
