import { type Db, schema } from '@domar/db';
import { pushPayload } from '@domar/domain';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { logEmail } from '../email/log.js';
import type { Mailer } from '../email/mailer.js';
import type { TenantContext } from '../tenant-context.js';
import type { Pusher } from './push.js';
import { deleteSubscriptionByEndpoint, notifyStaff, subscriptionsFor } from './repo.js';

const N = schema.notifications; const OA = schema.ownerAccounts;

export interface NotificationRuntime {
  pusher: Pusher;
  mailer: Mailer;
  log: { warn(obj: unknown, msg: string): void };
}

export interface DrainResult { claimed: number; pushed: number; emailed: number; failed: number }

export const notificationRuntime = (app: FastifyInstance): NotificationRuntime => ({ pusher: app.pusher, mailer: app.mailer, log: app.log });

const DEFAULT_LIMIT = 500;
/** Small enough that a crash between chunks costs one chunk, not the whole run's queue. */
const CHUNK_SIZE = 25;
/** The cron's `curl -m 120` gives the response twice this long to arrive. */
const DEFAULT_DEADLINE_MS = 60_000;

/**
 * Claims the undelivered tail in small chunks and sends each chunk before claiming the next.
 * `for update skip locked` is what makes two overlapping cron runs split the queue instead of
 * double-sending, and each chunk's `delivered_at` is stamped *before* the chunk is sent, so a crash
 * mid-run costs at most one chunk (`CHUNK_SIZE`), never the whole batch.
 *
 * `deadlineMs` bounds the wall-clock time of the run (checked between chunks, never inside one — a
 * chunk already has `delivered_at` stamped and there is no retry, so abandoning it partway would
 * strand those rows undelivered forever). A run that hits the deadline stops cleanly and returns
 * what it did; the caller can raise or lower the budget, but the cron's own timeout is the reason
 * for the default.
 */
export async function drainNotifications(db: Db, rt: NotificationRuntime, limit = DEFAULT_LIMIT, deadlineMs = DEFAULT_DEADLINE_MS): Promise<DrainResult> {
  const deadline = Date.now() + deadlineMs;
  const out: DrainResult = { claimed: 0, pushed: 0, emailed: 0, failed: 0 };
  // One bell per tenant per run, not one per failed notification (an SMTP outage with a backlog must
  // not itself flood the next run's claim budget with bell rows).
  const failedByTenant = new Map<string, { count: number; sampleId: string }>();

  while (out.claimed < limit && Date.now() < deadline) {
    const chunk = await claimChunk(db, Math.min(CHUNK_SIZE, limit - out.claimed));
    if (chunk.length === 0) break;
    out.claimed += chunk.length;

    for (const row of chunk) {
      // A staff row is an in-app bell and nothing else: no push, no email (plan addendum 12). It is
      // also what stops a failed delivery from recursing into another failed delivery.
      if (!row.ownerAccountId) continue;
      try {
        const error = await deliverToOwner(db, rt, row);
        if (error === null) { out.pushed += 1; continue; }
        if (error === 'emailed') { out.emailed += 1; continue; }
        out.failed += 1;
        await recordDeliveryError(db, row, error);
        trackFailure(failedByTenant, row);
      } catch (err) {
        // One unreachable endpoint must not cost the rest of the queue.
        rt.log.warn({ err, notificationId: row.id }, 'notification delivery threw; recorded as failed');
        out.failed += 1;
        await recordDeliveryError(db, row, (err instanceof Error ? err.message : 'delivery_failed').slice(0, 500));
        trackFailure(failedByTenant, row);
      }
    }
  }

  await ringFailureBells(db, failedByTenant);
  return out;
}

/** One transaction: the claim and the stamp are atomic, so a row is never returned half-claimed. */
async function claimChunk(db: Db, size: number): Promise<(typeof N.$inferSelect)[]> {
  return db.transaction(async (tx) => {
    const ids = await tx.select({ id: N.id }).from(N).where(isNull(N.deliveredAt))
      // `seq` alone orders the queue correctly (migration 0014): it is a strictly increasing
      // insertion counter, the same tie-break both bell listings already sort by.
      .orderBy(asc(N.seq)).limit(size).for('update', { skipLocked: true });
    if (ids.length === 0) return [];
    return tx.update(N).set({ deliveredAt: new Date() }).where(inArray(N.id, ids.map((i) => i.id))).returning();
  });
}

function trackFailure(map: Map<string, { count: number; sampleId: string }>, row: typeof N.$inferSelect): void {
  const existing = map.get(row.tenantId);
  if (existing) existing.count += 1;
  else map.set(row.tenantId, { count: 1, sampleId: row.id });
}

async function ringFailureBells(db: Db, failedByTenant: Map<string, { count: number; sampleId: string }>): Promise<void> {
  for (const [tenantId, { count, sampleId }] of failedByTenant) {
    const ctx: TenantContext = { tenantId, userId: null, role: 'owner' };
    const what = count === 1 ? '1 известување' : `${count} известувања`;
    await notifyStaff(db, ctx, { kind: 'delivery_failed', what, notificationId: sampleId });
  }
}

/** null = pushed; 'emailed' = the fallback carried it; any other string = the reason it failed. */
async function deliverToOwner(db: Db, rt: NotificationRuntime, row: typeof N.$inferSelect): Promise<string | null> {
  const [account] = await db.select({ email: OA.email, isActive: OA.isActive }).from(OA).where(eq(OA.id, row.ownerAccountId!)).limit(1);
  if (!account) return 'account_missing';
  // A deactivated login reads nothing — not the push, not the inbox — so there is no point trying.
  if (!account.isActive) return 'account_inactive';

  const subscriptions = await subscriptionsFor(db, row.ownerAccountId!);
  const payload = pushPayload({ id: row.id, title: row.title, link: row.link });
  let pushed = false;
  let lastError = 'no_subscription';
  for (const s of subscriptions) {
    const res = await rt.pusher.send({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, payload);
    if (res.ok) { pushed = true; continue; }
    lastError = res.error;
    // 404/410: the endpoint is gone for good, so the row goes with it (plan addendum 6).
    if (res.gone) await deleteSubscriptionByEndpoint(db, s.endpoint);
  }
  if (pushed) return null;

  const ctx: TenantContext = { tenantId: row.tenantId, userId: null, role: 'readonly' };
  const res = await rt.mailer.send({ to: account.email, subject: row.title, text: `${row.title}\n\n${row.body}` });
  const ok = 'id' in res;
  await logEmail(db, ctx, {
    to: account.email, subject: row.title, template: 'notification', refType: 'notification', refId: row.id,
    status: ok ? 'sent' : 'failed', error: ok ? null : res.error,
  });
  if (ok) return 'emailed';
  return `${lastError}; email: ${res.error}`.slice(0, 500);
}

async function recordDeliveryError(db: Db, row: typeof N.$inferSelect, error: string): Promise<void> {
  await db.update(N).set({ deliveryError: error.slice(0, 500) })
    .where(and(eq(N.tenantId, row.tenantId), eq(N.id, row.id)));
}
