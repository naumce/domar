import { readFileSync } from 'node:fs';
// Aliased: under vitest's jsdom pool, an import bound to the name `URL` resolves against jsdom's
// document location instead of this file's path — only a differently-named binding gets Node's.
import { fileURLToPath, URL as FileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const SOURCE = readFileSync(fileURLToPath(new FileURL('../public/portal/sw.js', import.meta.url)), 'utf8');

/** Runs the worker source against a fake global scope and hands back what it registered. */
function loadWorker() {
  const handlers = new Map<string, (e: unknown) => void>();
  const self = {
    addEventListener: (type: string, fn: (e: unknown) => void) => handlers.set(type, fn),
    registration: { showNotification: vi.fn(() => Promise.resolve()) },
    clients: {
      matchAll: vi.fn(() => Promise.resolve([] as { url: string; focus: () => void; navigate: (u: string) => void }[])),
      openWindow: vi.fn(() => Promise.resolve(null)),
    },
    skipWaiting: vi.fn(),
    caches: { open: vi.fn(() => Promise.resolve({ addAll: vi.fn(), match: vi.fn(() => Promise.resolve(undefined)) })), keys: vi.fn(() => Promise.resolve([])), delete: vi.fn() },
    location: { origin: 'https://domar.mk' },
  };
  new Function('self', 'caches', 'clients', SOURCE)(self, self.caches, self.clients);
  return { self, handlers };
}

describe('the portal service worker', () => {
  it('registers push, notificationclick, install, activate and fetch', () => {
    const { handlers } = loadWorker();
    expect([...handlers.keys()].sort()).toEqual(['activate', 'fetch', 'install', 'notificationclick', 'push']);
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

  it('opens the link when the notification is clicked', async () => {
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
    handlers.get('fetch')!({ request: { method: 'GET', mode: 'navigate', url: 'https://domar.mk/portal/invoices' }, respondWith });
    expect(respondWith).toHaveBeenCalledTimes(1);
  });
});
