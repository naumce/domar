import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { NotificationRow } from '@/api/types';
import NotificationBell from '@/components/layout/NotificationBell.vue';
import { i18n, messages } from '@/i18n';
import type { PushState } from '@/portal/push';
import { usePortalStore } from '@/stores/portal';

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const empty = () => new Response(null, { status: 204 });

const rows: NotificationRow[] = [
  { id: 'n-1', kind: 'invoice_published', title: 'Нова фактура · Партизанска 12', body: 'Вкупно за плаќање: 2.450,00 ден.', link: '/portal/invoices/i-1', createdAt: '2026-09-25T09:00:00.000Z', readAt: null },
  { id: 'n-2', kind: 'maintenance_status', title: 'Одржување: Во тек', body: 'Протекува цевка во визбата', link: '/portal/maintenance/m-1', createdAt: '2026-09-24T09:00:00.000Z', readAt: '2026-09-24T10:00:00.000Z' },
];

// The bell navigates with `useRouter()`, which needs a real router in scope — the shells always
// provide one; here a memory router with a catch-all stands in for it.
const testRouter = () => createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div/>' } }] });

const mountBell = (scope: 'app' | 'portal') =>
  mount(NotificationBell, { props: { scope }, global: { plugins: [i18n, testRouter()], stubs: { RouterLink: true } } });

describe('NotificationBell', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the manager’s own notifications and badges the unread ones', async () => {
    setActivePinia(createPinia());
    const fetchMock = vi.fn().mockResolvedValue(json({ rows, unread: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    const w = mountBell('app');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await flushPromises();
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://localhost:3001/api/notifications');
    expect(w.get('[data-test=notification-count]').text()).toBe('1');

    await w.get('[data-test=notification-bell]').trigger('click');
    expect(w.findAll('[data-test=notification-item]')).toHaveLength(2);
    expect(w.get('[data-test=notification-item]').text()).toContain('Нова фактура · Партизанска 12');
    // The body is shown in the app, where it belongs — only the push is title-and-link-only.
    expect(w.get('[data-test=notification-item]').text()).toContain('2.450,00 ден.');
  });

  it('marks one read and drops the badge', async () => {
    setActivePinia(createPinia());
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ rows, unread: 1 }))
      .mockResolvedValueOnce(empty())
      .mockResolvedValueOnce(json({ rows: rows.map((r) => ({ ...r, readAt: '2026-09-25T11:00:00.000Z' })), unread: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    const w = mountBell('app');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await flushPromises();
    await w.get('[data-test=notification-bell]').trigger('click');
    await w.get('[data-test=notification-item]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(String(fetchMock.mock.calls[1]![0])).toBe('http://localhost:3001/api/notifications/n-1/read');
    await flushPromises();
    expect(w.find('[data-test=notification-count]').exists()).toBe(false);
  });

  it('marks everything read at once', async () => {
    setActivePinia(createPinia());
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ rows, unread: 1 }))
      .mockResolvedValueOnce(empty())
      .mockResolvedValueOnce(json({ rows, unread: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    const w = mountBell('app');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await w.get('[data-test=notification-bell]').trigger('click');
    await w.get('[data-test=notification-mark-all]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(String(fetchMock.mock.calls[1]![0])).toBe('http://localhost:3001/api/notifications/read-all');
  });

  it('uses the portal routes and offers the push toggle in the portal', async () => {
    setActivePinia(createPinia());
    const fetchMock = vi.fn().mockResolvedValue(json({ rows: [], unread: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    // No PushManager in jsdom, so the toggle reports "unsupported" rather than throwing.
    // Nothing is selected in the store here, so the bell asks for every link's rows.
    const w = mountBell('portal');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await flushPromises();
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://localhost:3001/api/portal/notifications');
    await w.get('[data-test=notification-bell]').trigger('click');
    expect(w.get('[data-test=notification-empty]').text()).toBe('Нема известувања');
    expect(w.get('[data-test=notification-push-state]').text()).toBe('Не е поддржано на овој уред');
  });

  it('asks only for the selected link’s rows, and follows the selection', async () => {
    setActivePinia(createPinia());
    const portal = usePortalStore();
    // An owner account is cross-tenant, so without this scope the bell would list a row belonging to
    // the other manager — and every portal page would then fetch it with the wrong contact.
    portal.links = [
      { tenantId: 't-a', tenantName: 'Фирма А', contactId: 'c-a', contactName: 'Марко', buildings: [] },
      { tenantId: 't-b', tenantName: 'Фирма Б', contactId: 'c-b', contactName: 'Марко', buildings: [] },
    ];
    portal.select('c-a');
    // A fresh Response per call: a single one can only be read once, and this bell makes four.
    const fetchMock = vi.fn(() => Promise.resolve(json({ rows: [], unread: 0 })));
    vi.stubGlobal('fetch', fetchMock);
    const w = mountBell('portal');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://localhost:3001/api/portal/notifications?contactId=c-a');

    portal.select('c-b');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1]![0])).toBe('http://localhost:3001/api/portal/notifications?contactId=c-b');

    // And "mark all read" clears what is shown, not the other manager's rows.
    await w.get('[data-test=notification-bell]').trigger('click');
    await w.get('[data-test=notification-mark-all]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(String(fetchMock.mock.calls[2]![0])).toBe('http://localhost:3001/api/portal/notifications/read-all?contactId=c-b');
  });
});

describe('push state i18n coverage', () => {
  it('gives every pushState() value a label in both locales', () => {
    // `satisfies Record<PushState, unknown>` fails to compile if a value pushState() can return is
    // missing here — the next state added (like `unknown` was) cannot skip its label unnoticed.
    const everyState = { unsupported: 1, unconfigured: 1, denied: 1, off: 1, on: 1, unknown: 1 } satisfies Record<PushState, unknown>;
    for (const state of Object.keys(everyState) as PushState[]) {
      expect(messages.mk.notifications.push[state], `mk.notifications.push.${state}`).toBeTruthy();
      expect(messages.en.notifications.push[state], `en.notifications.push.${state}`).toBeTruthy();
    }
  });
});
