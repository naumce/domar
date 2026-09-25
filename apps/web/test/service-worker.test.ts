import { readFileSync } from 'node:fs';
// Aliased: Vite's `vite:asset-import-meta-url` transform pattern-matches the literal source text
// `new URL('...', import.meta.url)` and rewrites it into an asset-URL reference at build/transform
// time, regardless of what the `URL` binding actually points to. Importing it under a different
// name keeps the call out of that pattern, so it runs as plain Node code against this file's path.
import { fileURLToPath, URL as FileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const SOURCE = readFileSync(fileURLToPath(new FileURL('../public/sw.js', import.meta.url)), 'utf8');

type FakeWindow = { url: string; focus: ReturnType<typeof vi.fn>; navigate: ReturnType<typeof vi.fn> };

/** A same-origin cache: `addAll` stores by URL, `match` looks it up — a real path, not a stub. */
function makeFakeCache() {
  const store = new Map<string, { body: string }>();
  return {
    addAll: vi.fn((urls: string[]) => {
      for (const u of urls) store.set(u, { body: `cached:${u}` });
      return Promise.resolve();
    }),
    match: vi.fn((req: string) => Promise.resolve(store.get(req))),
  };
}

/** Runs the worker source against a fake global scope and hands back what it registered. */
function loadWorker() {
  const handlers = new Map<string, (e: unknown) => void>();
  const cache = makeFakeCache();
  const self = {
    addEventListener: (type: string, fn: (e: unknown) => void) => handlers.set(type, fn),
    registration: { showNotification: vi.fn(() => Promise.resolve()) },
    clients: {
      matchAll: vi.fn(() => Promise.resolve([] as FakeWindow[])),
      openWindow: vi.fn(() => Promise.resolve(null)),
    },
    skipWaiting: vi.fn(),
    caches: { open: vi.fn(() => Promise.resolve(cache)), keys: vi.fn(() => Promise.resolve([])), delete: vi.fn() },
    location: { origin: 'https://domar.mk' },
  };
  new Function('self', 'caches', 'clients', SOURCE)(self, self.caches, self.clients);
  return { self, handlers, cache };
}

/** Runs `install` to completion so the offline shell is actually in the fake cache, as in a browser. */
async function installed() {
  const loaded = loadWorker();
  const waits: Promise<unknown>[] = [];
  loaded.handlers.get('install')!({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
  await Promise.all(waits);
  return loaded;
}

describe('the portal service worker', () => {
  it('registers push, notificationclick, install, activate and fetch', () => {
    const { handlers } = loadWorker();
    expect([...handlers.keys()].sort()).toEqual(['activate', 'fetch', 'install', 'notificationclick', 'push']);
  });

  it('caches only the offline shell on install, never the unreachable icon', async () => {
    const { cache } = await installed();
    expect(cache.addAll).toHaveBeenCalledWith(['/portal/offline.html']);
  });

  it('shows the pushed title and keeps the link on the notification', async () => {
    const { self, handlers } = loadWorker();
    const waits: Promise<unknown>[] = [];
    handlers.get('push')!({
      data: { json: () => ({ id: 'n-1', title: 'Нова фактура · Партизанска 12', link: '/portal/invoices/i-1' }) },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    await Promise.all(waits);
    expect(self.registration.showNotification).toHaveBeenCalledTimes(1);
    const [title, options] = self.registration.showNotification.mock.calls[0] as unknown as [string, { data: { link: string }; body?: string }];
    expect(title).toBe('Нова фактура · Партизанска 12');
    expect(options.data.link).toBe('/portal/invoices/i-1');
    // Spec §11: the payload has no body, so the notification shows none.
    expect(options.body ?? '').toBe('');
  });

  it('shows a generic notification instead of throwing on a null or malformed payload', async () => {
    for (const data of [{ json: () => null }, { json: () => 'not an object' }, { json: () => { throw new SyntaxError('bad json'); } }, undefined]) {
      const { self, handlers } = loadWorker();
      const waits: Promise<unknown>[] = [];
      expect(() => handlers.get('push')!({ data, waitUntil: (p: Promise<unknown>) => waits.push(p) })).not.toThrow();
      await Promise.all(waits);
      expect(self.registration.showNotification).toHaveBeenCalledWith('domar', expect.objectContaining({ data: { link: '/portal' } }));
    }
  });

  it('falls back to the cached offline page when the network fetch fails', async () => {
    const { handlers, cache } = await installed();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    const respondWith = vi.fn();
    handlers.get('fetch')!({ request: { method: 'GET', mode: 'navigate', url: 'https://domar.mk/portal/invoices' }, respondWith });
    expect(respondWith).toHaveBeenCalledTimes(1);
    const [responded] = respondWith.mock.calls[0] as [Promise<{ body: string } | undefined>];
    await expect(responded).resolves.toEqual({ body: 'cached:/portal/offline.html' });
    expect(cache.match).toHaveBeenCalledWith('/portal/offline.html');
    vi.unstubAllGlobals();
  });

  it('opens the link when the notification is clicked and no portal tab is open', async () => {
    const { self, handlers } = loadWorker();
    const waits: Promise<unknown>[] = [];
    const close = vi.fn();
    handlers.get('notificationclick')!({
      notification: { data: { link: '/portal/invoices/i-1' }, close },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    await Promise.all(waits);
    expect(close).toHaveBeenCalled();
    expect(self.clients.openWindow).toHaveBeenCalledWith('/portal/invoices/i-1');
  });

  it('navigates and focuses an already-open portal tab instead of opening a new one', async () => {
    const { self, handlers } = loadWorker();
    const win: FakeWindow = { url: 'https://domar.mk/portal', focus: vi.fn(() => Promise.resolve(win)), navigate: vi.fn(() => Promise.resolve(win)) };
    self.clients.matchAll.mockResolvedValue([win]);
    const waits: Promise<unknown>[] = [];
    handlers.get('notificationclick')!({
      notification: { data: { link: '/portal/invoices/i-1' }, close: vi.fn() },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    await Promise.all(waits);
    expect(win.navigate).toHaveBeenCalledWith('/portal/invoices/i-1');
    expect(win.focus).toHaveBeenCalled();
    expect(self.clients.openWindow).not.toHaveBeenCalled();
  });

  it('opens a new window when navigating the open portal tab is refused, instead of leaving it unhandled', async () => {
    const { self, handlers } = loadWorker();
    const win: FakeWindow = { url: 'https://domar.mk/portal', focus: vi.fn(() => Promise.resolve(win)), navigate: vi.fn(() => Promise.reject(new Error('not allowed'))) };
    self.clients.matchAll.mockResolvedValue([win]);
    const waits: Promise<unknown>[] = [];
    handlers.get('notificationclick')!({
      notification: { data: { link: '/portal/invoices/i-1' }, close: vi.fn() },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    await Promise.all(waits);
    expect(win.focus).not.toHaveBeenCalled();
    expect(self.clients.openWindow).toHaveBeenCalledWith('/portal/invoices/i-1');
  });

  it('never intercepts the API', () => {
    const { handlers } = loadWorker();
    const respondWith = vi.fn();
    for (const url of ['https://domar.mk/api/portal/invoices', 'https://domar.mk/api/health']) {
      handlers.get('fetch')!({ request: { method: 'GET', mode: 'navigate', url }, respondWith });
    }
    expect(respondWith).not.toHaveBeenCalled();
  });

  it('only ever handles same-origin GET navigations', () => {
    const { handlers } = loadWorker();
    const respondWith = vi.fn();
    handlers.get('fetch')!({ request: { method: 'POST', mode: 'navigate', url: 'https://domar.mk/portal' }, respondWith });
    handlers.get('fetch')!({ request: { method: 'GET', mode: 'cors', url: 'https://domar.mk/portal/invoices' }, respondWith });
    handlers.get('fetch')!({ request: { method: 'GET', mode: 'navigate', url: 'https://elsewhere.mk/portal' }, respondWith });
    expect(respondWith).not.toHaveBeenCalled();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true })));
    handlers.get('fetch')!({ request: { method: 'GET', mode: 'navigate', url: 'https://domar.mk/portal/invoices' }, respondWith });
    expect(respondWith).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
