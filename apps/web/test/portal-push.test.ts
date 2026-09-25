import { afterEach, describe, expect, it, vi } from 'vitest';
import { disablePush, enablePush, pushState } from '@/portal/push';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const empty = () => new Response(null, { status: 204 });

function stubServiceWorker(subscription: unknown) {
  const subscribe = vi.fn(() => Promise.resolve(subscription));
  const registration = {
    pushManager: { getSubscription: vi.fn(() => Promise.resolve(subscription)), subscribe },
  };
  vi.stubGlobal('navigator', {
    serviceWorker: {
      register: vi.fn(() => Promise.resolve(registration)),
      // `activeRegistration()` looks this up first instead of awaiting `.ready`, which never
      // settles for a page outside /portal/ or before the first activation.
      getRegistration: vi.fn(() => Promise.resolve(registration)),
      ready: Promise.resolve(registration),
    },
    userAgent: 'vitest',
  });
  vi.stubGlobal('PushManager', class {});
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission: vi.fn(() => Promise.resolve('granted')) });
  return { registration, subscribe };
}

const fakeSubscription = {
  endpoint: 'https://push.example/e1',
  toJSON: () => ({ endpoint: 'https://push.example/e1', keys: { p256dh: 'kkk', auth: 'aaa' } }),
  unsubscribe: vi.fn(() => Promise.resolve(true)),
};

describe('portal push', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is "unsupported" when the browser has no PushManager', async () => {
    vi.stubGlobal('navigator', { userAgent: 'vitest' });
    vi.stubGlobal('fetch', vi.fn());
    await expect(pushState()).resolves.toBe('unsupported');
  });

  it('is "unconfigured" when the server has no VAPID key', async () => {
    stubServiceWorker(null);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ publicKey: null })));
    await expect(pushState()).resolves.toBe('unconfigured');
  });

  it('is "unknown" rather than throwing when the server call fails', async () => {
    stubServiceWorker(null);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(pushState()).resolves.toBe('unknown');
  });

  it('is "unknown", not a hang, when no registration exists and none can be created', async () => {
    vi.stubGlobal('navigator', {
      serviceWorker: {
        register: vi.fn(() => Promise.reject(new Error('registration refused'))),
        getRegistration: vi.fn(() => Promise.resolve(undefined)),
        ready: new Promise(() => {}), // must never be awaited by pushState — it would hang forever
      },
      userAgent: 'vitest',
    });
    vi.stubGlobal('PushManager', class {});
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: vi.fn() });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ publicKey: 'BPublic' })));
    await expect(pushState()).resolves.toBe('unknown');
  });

  it('subscribes and posts the endpoint and both keys', async () => {
    const { subscribe } = stubServiceWorker(null);
    subscribe.mockResolvedValue(fakeSubscription);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ publicKey: 'BPublic' }))
      .mockResolvedValueOnce(empty());
    vi.stubGlobal('fetch', fetchMock);

    await expect(enablePush()).resolves.toBe('on');
    expect(String(fetchMock.mock.calls[1]![0])).toBe('http://localhost:3001/api/portal/push/subscribe');
    expect(JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body))).toEqual({
      endpoint: 'https://push.example/e1', p256dh: 'kkk', auth: 'aaa', userAgent: 'vitest',
    });
  });

  it('re-subscribes when the existing subscription was made against a since-rotated VAPID key', async () => {
    const stale = {
      endpoint: 'https://push.example/stale',
      options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer },
      unsubscribe: vi.fn(() => Promise.resolve(true)),
    };
    const { subscribe } = stubServiceWorker(stale);
    subscribe.mockResolvedValue(fakeSubscription);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ publicKey: 'BPublic' }))
      .mockResolvedValueOnce(empty());
    vi.stubGlobal('fetch', fetchMock);

    await expect(enablePush()).resolves.toBe('on');
    expect(stale.unsubscribe).toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalled();
    expect(JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body))).toMatchObject({ endpoint: 'https://push.example/e1' });
  });

  it('unsubscribes locally when the subscribe POST fails, so the two sides cannot disagree', async () => {
    fakeSubscription.unsubscribe.mockClear();
    const { subscribe } = stubServiceWorker(null);
    subscribe.mockResolvedValue(fakeSubscription);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ publicKey: 'BPublic' }))
      .mockResolvedValueOnce(json({ error: { code: 'rejected', message: 'no' } }, 400));
    vi.stubGlobal('fetch', fetchMock);

    await expect(enablePush()).rejects.toThrow();
    expect(fakeSubscription.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('fails honestly instead of posting empty keys when the subscription has none', async () => {
    const incomplete = {
      endpoint: 'https://push.example/e2',
      toJSON: () => ({ endpoint: 'https://push.example/e2', keys: {} }),
      unsubscribe: vi.fn(() => Promise.resolve(true)),
    };
    const { subscribe } = stubServiceWorker(null);
    subscribe.mockResolvedValue(incomplete);
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ publicKey: 'BPublic' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(enablePush()).rejects.toThrow();
    expect(incomplete.unsubscribe).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1); // the key lookup only — never a subscribe POST with blank keys
  });

  it('unsubscribes locally and on the server', async () => {
    stubServiceWorker(fakeSubscription);
    const fetchMock = vi.fn().mockResolvedValue(empty());
    vi.stubGlobal('fetch', fetchMock);
    await disablePush();
    expect(fakeSubscription.unsubscribe).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://localhost:3001/api/portal/push/unsubscribe');
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({ endpoint: 'https://push.example/e1' });
  });
});
