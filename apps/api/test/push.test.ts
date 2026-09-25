import { schema } from '@domar/db';
import { NOTIFICATION_KINDS } from '@domar/domain';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createPusher } from '../src/notifications/push.js';

// web-push is CJS with a single `module.exports` object; mocking it as both the default export and
// the named exports covers however the test runner resolves `import webpush, { WebPushError }`.
// `sendNotification` starts as a no-op resolver; individual tests override it with mockRejectedValueOnce.
vi.mock('web-push', () => {
  class WebPushError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.statusCode = statusCode;
    }
  }
  const mod = { setVapidDetails: vi.fn(), sendNotification: vi.fn().mockResolvedValue(undefined), WebPushError };
  return { ...mod, default: mod };
});

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

  it('turns push off, and does not throw, when web-push rejects the key pair', async () => {
    const webpush = (await import('web-push')).default;
    // Every other test uses VAPID_PRIVATE_KEY=memory, which never reaches `setVapidDetails` — this
    // is the boot path an operator hits by pasting the pair in the wrong order. web-push validates
    // eagerly ("Vapid public key should be 65 bytes long when decoded."), and an uncaught throw
    // here would take the whole API down instead of leaving push off as DEPLOY.md promises.
    vi.mocked(webpush.setVapidDetails).mockImplementationOnce(() => { throw new Error('Vapid public key should be 65 bytes long when decoded.'); });
    const warn = vi.fn();
    const pusher = createPusher(loadConfig({ ...base, VAPID_PUBLIC_KEY: 'not-a-key', VAPID_PRIVATE_KEY: 'BPrivate', VAPID_SUBJECT: 'mailto:no-reply@domar.mk' }), { warn });
    expect(pusher.configured).toBe(false);
    expect(pusher.publicKey).toBeNull();
    await expect(pusher.send(target, payload)).resolves.toEqual({ ok: false, error: 'vapid_invalid', gone: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![1])).toContain('VAPID');
    // And nothing was sent: the caller falls back to email on the recorded reason.
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it('bounds the real transport with a socket timeout, and treats a timeout as recoverable, not gone', async () => {
    const webpush = (await import('web-push')).default;
    const pusher = createPusher(loadConfig({ ...base, VAPID_PUBLIC_KEY: 'BPublic', VAPID_PRIVATE_KEY: 'BPrivate', VAPID_SUBJECT: 'mailto:no-reply@domar.mk' }));
    // web-push raises a plain Error (not a WebPushError) when its own socket timeout fires, so the
    // mocked rejection mirrors that exactly rather than simulating a slow real send.
    vi.mocked(webpush.sendNotification).mockRejectedValueOnce(new Error('Socket timeout'));
    await expect(pusher.send(target, payload)).resolves.toEqual({ ok: false, error: 'Socket timeout', gone: false });
    // The row is never touched by send() itself; a false `gone` is what stops a caller from deleting it.
    expect(pusher.sent).toEqual([]);
    expect(webpush.sendNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ timeout: 10_000 }),
    );
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
