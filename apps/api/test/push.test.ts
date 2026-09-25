import { schema } from '@domar/db';
import { NOTIFICATION_KINDS } from '@domar/domain';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createPusher } from '../src/notifications/push.js';

const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/d', NODE_ENV: 'test' } as NodeJS.ProcessEnv;
const target = { endpoint: 'https://push.example/abc', p256dh: 'p', auth: 'a' };
const payload = { id: 'n-1', title: 'Нова фактура', link: '/portal/invoices/i-1' };

describe('createPusher', () => {
  it('is a no-op that never throws when VAPID is unset', async () => {
    const pusher = createPusher(loadConfig(base));
    expect(pusher.configured).toBe(false);
    expect(pusher.publicKey).toBeNull();
    await expect(pusher.send(target, payload)).resolves.toEqual({ ok: false, error: 'vapid_not_configured', gone: false });
  });

  it('captures in memory when VAPID_PRIVATE_KEY is "memory"', async () => {
    const pusher = createPusher(loadConfig({ ...base, VAPID_PUBLIC_KEY: 'BPublic', VAPID_PRIVATE_KEY: 'memory', VAPID_SUBJECT: 'mailto:no-reply@domar.mk' }));
    expect(pusher.configured).toBe(true);
    expect(pusher.publicKey).toBe('BPublic');
    await expect(pusher.send(target, payload)).resolves.toEqual({ ok: true });
    expect(pusher.sent).toEqual([{ endpoint: target.endpoint, payload }]);
    // What travels the wire is the payload object itself: no body, no amount.
    expect(Object.keys(pusher.sent[0]!.payload).sort()).toEqual(['id', 'link', 'title']);
  });
});

describe('notification kinds', () => {
  it('keeps the db enum and the domain list in lockstep', () => {
    // packages/db does not depend on @domar/domain, so these are two hand-kept lists; apps/api is
    // the only package that imports both, and this assertion is the only thing that will catch them
    // drifting (task 2 ruling R3).
    expect(schema.notificationKind.enumValues).toEqual(NOTIFICATION_KINDS);
  });
});
