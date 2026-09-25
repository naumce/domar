import { type Db, schema } from '@domar/db';
import { pushPayload } from '@domar/domain';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { logEmail } from '../email/log.js';
import type { Mailer } from '../email/mailer.js';
import type { TenantContext } from '../tenant-context.js';
import type { Pusher, PushResult } from './push.js';
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
/**
 * Small enough that a crash between chunks costs one chunk, not the whole run's queue, and small
 * enough that one chunk's own worst case fits inside the deadline: a chunk is delivered
 * concurrently, so it costs roughly one push timeout (10s) per subscription an owner has, not one
 * per row. Twenty-five rows sent one after another would have taken eight minutes with every
 * endpoint timing out — longer than the run's whole budget and longer than the cron's `curl -m 120`.
 */
const CHUNK_SIZE = 10;
/** The cron's `curl -m 120` gives the response twice this long to arrive. */
const DEFAULT_DEADLINE_MS = 60_000;
/**
 * What one row's whole fan-out may cost in wall-clock, however many browsers the owner registered.
 * The subscriptions are sent concurrently and each send carries its own 10s socket timeout, so this
 * only ever bites when the push service accepts the connection and then stalls — but without it the
 * run's deadline, which is checked between chunks and never inside one, could not stop it at all.
 * A row that blows the budget takes the email fallback, exactly like a row whose pushes all failed.
 */
const DEFAULT_ROW_BUDGET_MS = 15_000;

/**
 * Claims the undelivered tail in small chunks and sends each chunk before claiming the next.
 * `for update skip locked` is what makes two overlapping cron runs split the queue instead of
 * double-sending, and each chunk's `delivered_at` is stamped *before* the chunk is sent, so a crash
 * mid-run costs at most one chunk (`CHUNK_SIZE`), never the whole batch.
 *
 * `deadlineMs` bounds the wall-clock time of the run (checked between chunks, never inside one — a
 * chunk already has `delivered_at` stamped and there is no retry, so abandoning it partway would
 * strand those rows undelivered forever, which is also why a chunk is small and is delivered
 * concurrently). A run that hits the deadline stops cleanly and returns
 * what it did; the caller can raise or lower the budget, but the cron's own timeout is the reason
 * for the default.
 */
export async function drainNotifications(db: Db, rt: NotificationRuntime, limit = DEFAULT_LIMIT, deadlineMs = DEFAULT_DEADLINE_MS, rowBudgetMs = DEFAULT_ROW_BUDGET_MS): Promise<DrainResult> {
  const deadline = Date.now() + deadlineMs;
  const out: DrainResult = { claimed: 0, pushed: 0, emailed: 0, failed: 0 };
  // One bell per tenant per run, not one per failed notification (an SMTP outage with a backlog must
  // not itself flood the next run's claim budget with bell rows).
  const failedByTenant = new Map<string, { count: number; sampleId: string }>();

  while (out.claimed < limit && Date.now() < deadline) {
    const chunk = await claimChunk(db, Math.min(CHUNK_SIZE, limit - out.claimed));
    if (chunk.length === 0) break;
    out.claimed += chunk.length;

    // Concurrently within the chunk: a dead push service costs the chunk one timeout, not one per
    // row. The callbacks touch `out` and `failedByTenant` only after their own await, and JavaScript
    // runs them one at a time, so the counters need no locking.
    await Promise.all(chunk.map(async (row) => {
      // A staff row is an in-app bell and nothing else: no push, no email (plan addendum 12). It is
      // also what stops a failed delivery from recursing into another failed delivery.
      if (!row.ownerAccountId) return;
      try {
        const error = await deliverToOwner(db, rt, row, rowBudgetMs);
        if (error === null) { out.pushed += 1; return; }
        if (error === 'emailed') { out.emailed += 1; return; }
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
    }));
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

/**
 * Resolves `true` if `work` finished inside `ms`, `false` if the budget ran out first. The work is
 * not cancellable — nothing here can abort an in-flight socket — so this bounds the *waiting*, and
 * `work` is written never to reject so that a late settlement cannot become an unhandled rejection.
 */
function withinBudget(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  return Promise.race([work.then(() => true), guard]).finally(() => clearTimeout(timer));
}

/** null = pushed; 'emailed' = the fallback carried it; any other string = the reason it failed. */
async function deliverToOwner(db: Db, rt: NotificationRuntime, row: typeof N.$inferSelect, budgetMs: number): Promise<string | null> {
  const [account] = await db.select({ email: OA.email, isActive: OA.isActive }).from(OA).where(eq(OA.id, row.ownerAccountId!)).limit(1);
  if (!account) return 'account_missing';
  // A deactivated login reads nothing — not the push, not the inbox — so there is no point trying.
  if (!account.isActive) return 'account_inactive';

  const subscriptions = await subscriptionsFor(db, row.ownerAccountId!);
  const payload = pushPayload({ id: row.id, title: row.title, link: row.link });
  // Concurrently, and behind a budget: an owner's browsers are sent to at once, so the row costs one
  // push timeout rather than one per subscription, and a stalled endpoint cannot hold the queue for
  // longer than `budgetMs` no matter how many of them there are.
  const outcomes: PushResult[] = [];
  const sends = subscriptions.map(async (s) => {
    try {
      const res = await rt.pusher.send({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, payload);
      outcomes.push(res);
      // 404/410: the endpoint is gone for good, so the row goes with it (plan addendum 6).
      if (!res.ok && res.gone) await deleteSubscriptionByEndpoint(db, s.endpoint);
    } catch (err) {
      // Never rethrow: a send that settles after the budget has already elapsed is nobody's await
      // any more, and an unhandled rejection would take the process down with it.
      outcomes.push({ ok: false, error: (err instanceof Error ? err.message : 'push_failed').slice(0, 500), gone: false });
    }
  });
  const finished = await withinBudget(Promise.all(sends), budgetMs);
  const pushed = outcomes.some((o) => o.ok);
  let lastError = subscriptions.length === 0 ? 'no_subscription' : 'push_failed';
  for (const o of outcomes) if (!o.ok) lastError = o.error;
  if (!finished && !pushed) lastError = 'push_budget_exceeded';
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
