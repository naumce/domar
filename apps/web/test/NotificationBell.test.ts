import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { NotificationRow } from '@/api/types';
import NotificationBell from '@/components/layout/NotificationBell.vue';
import { i18n } from '@/i18n';
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
    const me = {
      account: { id: 'a1', email: 'marko@owner.mk' },
      links: [{ tenantId: 't1', tenantName: 'Фирма 1', contactId: 'c1', contactName: 'Марко Марков', buildings: [{ id: 'b1', name: 'Партизанска 12' }] }],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(me))
      .mockResolvedValue(json({ rows: [], unread: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    // No PushManager in jsdom, so the toggle reports "unsupported" rather than throwing.
    const store = usePortalStore();
    await store.fetchMe();
    const w = mountBell('portal');
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
    await flushPromises();
    expect(String(fetchMock.mock.calls[1]![0])).toBe('http://localhost:3001/api/portal/notifications');
    await w.get('[data-test=notification-bell]').trigger('click');
    expect(w.get('[data-test=notification-empty]').text()).toBe('Нема известувања');
    expect(w.get('[data-test=notification-push-state]').text()).toBe('Не е поддржано на овој уред');
  });
});
