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

/**
 * Claims the undelivered tail and sends it. `for update skip locked` is what makes two overlapping
 * cron runs split the queue instead of double-sending, and `delivered_at` is stamped *before* the
 * first network call, so a crash mid-run costs at most one notification (plan addendum 4).
 */
export async function drainNotifications(db: Db, rt: NotificationRuntime, limit = DEFAULT_LIMIT): Promise<DrainResult> {
  const claimed = await db.transaction(async (tx) => {
    const ids = await tx.select({ id: N.id }).from(N).where(isNull(N.deliveredAt))
      .orderBy(asc(N.createdAt), asc(N.id)).limit(limit).for('update', { skipLocked: true });
    if (ids.length === 0) return [];
    return tx.update(N).set({ deliveredAt: new Date() }).where(inArray(N.id, ids.map((i) => i.id))).returning();
  });

  const out: DrainResult = { claimed: claimed.length, pushed: 0, emailed: 0, failed: 0 };
  for (const row of claimed) {
    // A staff row is an in-app bell and nothing else: no push, no email (plan addendum 12). It is
    // also what stops a failed delivery from recursing into another failed delivery.
    if (!row.ownerAccountId) continue;
    try {
      const error = await deliverToOwner(db, rt, row);
      if (error === null) { out.pushed += 1; continue; }
      if (error === 'emailed') { out.emailed += 1; continue; }
      out.failed += 1;
      await recordFailure(db, rt, row, error);
    } catch (err) {
      // One unreachable endpoint must not cost the rest of the queue.
      rt.log.warn({ err, notificationId: row.id }, 'notification delivery threw; recorded as failed');
      out.failed += 1;
      await recordFailure(db, rt, row, (err instanceof Error ? err.message : 'delivery_failed').slice(0, 500));
    }
  }
  return out;
}

/** null = pushed; 'emailed' = the fallback carried it; any other string = the reason it failed. */
async function deliverToOwner(db: Db, rt: NotificationRuntime, row: typeof N.$inferSelect): Promise<string | null> {
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

  const [account] = await db.select({ email: OA.email }).from(OA).where(eq(OA.id, row.ownerAccountId!)).limit(1);
  if (!account) return 'account_missing';
  const ctx: TenantContext = { tenantId: row.tenantId, userId: null, role: 'readonly' };
  const res = await rt.mailer.send({ to: account.email, subject: row.title, text: `${row.title}\n\n${row.body}` });
  const ok = 'id' in res;
  await db.transaction(async (tx) => {
    await logEmail(tx, ctx, {
      to: account.email, subject: row.title, template: 'notification', refType: 'notification', refId: row.id,
      status: ok ? 'sent' : 'failed', error: ok ? null : res.error,
    });
  });
  if (ok) return 'emailed';
  return `${lastError}; email: ${res.error}`.slice(0, 500);
}

/** Spec §9's second manager-side bell: a send that failed both ways. */
async function recordFailure(db: Db, rt: NotificationRuntime, row: typeof N.$inferSelect, error: string): Promise<void> {
  const ctx: TenantContext = { tenantId: row.tenantId, userId: null, role: 'owner' };
  await db.transaction(async (tx) => {
    await tx.update(N).set({ deliveryError: error.slice(0, 500) })
      .where(and(eq(N.tenantId, ctx.tenantId), eq(N.id, row.id)));
    await notifyStaff(tx, ctx, { kind: 'delivery_failed', what: row.title, notificationId: row.id });
  });
}
