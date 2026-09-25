import type { PushPayload } from '@domar/domain';
import webpush, { WebPushError } from 'web-push';
import type { Config } from '../config.js';

export interface PushTarget { endpoint: string; p256dh: string; auth: string }
export type PushResult = { ok: true } | { ok: false; error: string; gone: boolean };
export interface SentPush { endpoint: string; payload: PushPayload }

export interface Pusher {
  readonly configured: boolean;
  /** The application server key the portal hands to `PushManager.subscribe`; null when unset. */
  readonly publicKey: string | null;
  /** Messages captured by the in-memory transport (`VAPID_PRIVATE_KEY=memory`); empty otherwise. */
  readonly sent: SentPush[];
  send(target: PushTarget, payload: PushPayload): Promise<PushResult>;
}

/** One day: a notification nobody's phone collected within a day is stale, and the app still has it. */
const TTL_SECONDS = 86_400;
/** Matches the mailer's connectionTimeout. The drain job (Task 5) awaits sends in a loop, so a
 * stalled or black-holed push endpoint must not be able to hang the whole run. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Without `VAPID_PRIVATE_KEY` — or with a pair `web-push` refuses — this is an explicit no-op:
 * `send` answers `{ ok: false, error: … }` so the caller records the reason and falls back to email,
 * and nothing ever throws for lack of a usable key (plan addendum 5, mirroring `createMailer`).
 */
export function createPusher(config: Config, log?: { warn(obj: unknown, msg: string): void }): Pusher {
  const sent: SentPush[] = [];
  const off = (error: string): Pusher => ({
    configured: false,
    publicKey: null,
    sent,
    async send() { return { ok: false, error, gone: false }; },
  });
  if (!config.vapidPrivateKey || !config.vapidPublicKey) return off('vapid_not_configured');
  const capture = config.vapidPrivateKey === 'memory';
  if (!capture) {
    try {
      webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
    } catch (err) {
      // web-push validates the pair eagerly and throws on a malformed key, a swapped pair or an
      // empty subject. `.env.example` and DEPLOY.md both promise that bad VAPID configuration turns
      // push off; an uncaught throw here would instead restart-loop the whole API.
      log?.warn({ err }, 'VAPID configuration rejected; push is off and notifications fall back to email');
      return off('vapid_invalid');
    }
  }
  return {
    configured: true,
    publicKey: config.vapidPublicKey,
    sent,
    async send(target: PushTarget, payload: PushPayload): Promise<PushResult> {
      if (capture) {
        sent.push({ endpoint: target.endpoint, payload });
        return { ok: true };
      }
      try {
        await webpush.sendNotification(
          { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
          JSON.stringify(payload),
          { TTL: TTL_SECONDS, timeout: REQUEST_TIMEOUT_MS },
        );
        return { ok: true };
      } catch (err) {
        // 404/410 are the standard's "this endpoint is gone for good"; everything else — including
        // a socket timeout, which web-push raises as a plain Error with no statusCode — may recover,
        // so the subscription stays (plan addendum 6).
        const status = err instanceof WebPushError ? err.statusCode : 0;
        const error = (err instanceof Error ? err.message : 'push_failed').slice(0, 500);
        return { ok: false, error, gone: status === 404 || status === 410 };
      }
    },
  };
}
