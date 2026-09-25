import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PortalMaintenanceRequest, PortalMaintenanceRow } from '@/api/types';
import { i18n } from '@/i18n';
import PortalMaintenancePage from '@/pages/portal/PortalMaintenancePage.vue';
import PortalMaintenanceRequestPage from '@/pages/portal/PortalMaintenanceRequestPage.vue';
import { usePortalStore } from '@/stores/portal';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const me = {
  account: { id: 'a1', email: 'marko@owner.mk' },
  links: [{ tenantId: 't1', tenantName: 'Фирма 1', contactId: 'c1', contactName: 'Марко Марков', buildings: [{ id: 'b1', name: 'Партизанска 12' }] }],
};
const row: PortalMaintenanceRow = {
  id: 'mr-1', buildingId: 'b1', buildingName: 'Партизанска 12', unitLabel: '1',
  title: 'Протекува цевка во визбата', category: 'plumbing', priority: 'high', status: 'in_progress',
  photoCount: 1, closedAt: null, createdAt: '2026-09-25T09:00:00.000Z', updatedAt: '2026-09-25T10:00:00.000Z',
};
const detail: PortalMaintenanceRequest = {
  ...row, description: 'Вода тече покрај вертикалата под влезот.',
  photos: [{ documentId: 'doc-1', fileName: 'voda.png', mime: 'image/png', sizeBytes: 1024, createdAt: '2026-09-25T09:00:00.000Z' }],
  events: [
    { id: 'ev-1', kind: 'created', toStatus: 'new', note: 'Протекува цевка во визбата', authorName: 'Марко Марков', authorKind: 'owner', createdAt: '2026-09-25T09:00:00.000Z' },
    { id: 'ev-2', kind: 'status_changed', toStatus: 'in_progress', note: 'Мајсторот е на пат.', authorName: 'Ива Тест', authorKind: 'manager', createdAt: '2026-09-25T10:00:00.000Z' },
  ],
};

async function primedStore(fetchMock: ReturnType<typeof vi.fn>) {
  setActivePinia(createPinia());
  vi.stubGlobal('fetch', fetchMock);
  const store = usePortalStore();
  await store.fetchMe();
  return store;
}

describe('PortalMaintenancePage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lists the owner’s own requests with their status', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(me)).mockResolvedValueOnce(json({ rows: [row] }));
    await primedStore(fetchMock);
    const w = mount(PortalMaintenancePage, { global: { plugins: [i18n], stubs: { RouterLink: true } } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await flushPromises();
    expect(String(fetchMock.mock.calls[1]![0])).toBe('http://localhost:3001/api/portal/maintenance?contactId=c1');
    expect(w.findAll('[data-test=portal-maintenance-row]')).toHaveLength(1);
    expect(w.get('[data-test=portal-maintenance-status]').text()).toBe('Во тек');
    expect(w.get('[data-test=portal-maintenance-row]').text()).toContain('Протекува цевка во визбата');
  });

  it('reports a problem and then uploads the chosen photo to it', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(me))
      .mockResolvedValueOnce(json({ rows: [] }))
      .mockResolvedValueOnce(json(detail))        // POST /portal/maintenance
      .mockResolvedValueOnce(json(detail))        // POST …/photos
      .mockResolvedValueOnce(json({ rows: [row] })); // reload
    await primedStore(fetchMock);
    const w = mount(PortalMaintenancePage, { global: { plugins: [i18n], stubs: { RouterLink: true } } });
    await vi.waitFor(() => expect(w.find('[data-test=portal-maintenance-submit]').exists()).toBe(true));

    await w.get('[data-test=portal-maintenance-title]').setValue('Протекува цевка во визбата');
    await w.get('[data-test=portal-maintenance-description]').setValue('Вода тече покрај вертикалата под влезот.');
    await w.get('[data-test=portal-maintenance-category]').setValue('plumbing');
    await w.get('[data-test=portal-maintenance-priority]').setValue('high');
    // The file input is set directly: jsdom will not let a test click through a real file dialog.
    const input = w.get('[data-test=portal-maintenance-file]').element as HTMLInputElement;
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'voda.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await w.get('[data-test=portal-maintenance-file]').trigger('change');
    await w.get('[data-test=portal-maintenance-submit]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));

    const post = fetchMock.mock.calls[2]!;
    expect(String(post[0])).toBe('http://localhost:3001/api/portal/maintenance');
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({
      contactId: 'c1', buildingId: 'b1',
      title: 'Протекува цевка во визбата', description: 'Вода тече покрај вертикалата под влезот.',
      category: 'plumbing', priority: 'high',
    });
    const upload = fetchMock.mock.calls[3]!;
    expect(String(upload[0])).toBe('http://localhost:3001/api/portal/maintenance/mr-1/photos');
    const form = (upload[1] as RequestInit).body as FormData;
    expect(form.get('contactId')).toBe('c1');
    expect((form.get('file') as File).name).toBe('voda.png');
  });

  it('refuses to send a request with no title', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(me)).mockResolvedValueOnce(json({ rows: [] }));
    await primedStore(fetchMock);
    const w = mount(PortalMaintenancePage, { global: { plugins: [i18n], stubs: { RouterLink: true } } });
    await vi.waitFor(() => expect(w.find('[data-test=portal-maintenance-submit]').exists()).toBe(true));
    await w.get('[data-test=portal-maintenance-submit]').trigger('click');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(w.get('[data-test=portal-page-error]').text()).toBe('Проверете ги внесените податоци.');
  });
});

describe('PortalMaintenanceRequestPage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows the timeline, the manager’s note and the photo', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(me)).mockResolvedValueOnce(json(detail));
    await primedStore(fetchMock);
    const w = mount(PortalMaintenanceRequestPage, { props: { id: 'mr-1' }, global: { plugins: [i18n], stubs: { RouterLink: true } } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await flushPromises();
    expect(String(fetchMock.mock.calls[1]![0])).toBe('http://localhost:3001/api/portal/maintenance/mr-1?contactId=c1');
    expect(w.get('[data-test=portal-maintenance-status]').text()).toBe('Во тек');
    expect(w.findAll('[data-test=portal-maintenance-event]')).toHaveLength(2);
    expect(w.text()).toContain('Мајсторот е на пат.');
    expect(w.get('[data-test=portal-maintenance-photo]').attributes('src'))
      .toBe('http://localhost:3001/api/portal/maintenance/mr-1/photos/doc-1?contactId=c1');
  });

  it('sends a note from the owner', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(me)).mockResolvedValueOnce(json(detail)).mockResolvedValueOnce(json(detail));
    await primedStore(fetchMock);
    const w = mount(PortalMaintenanceRequestPage, { props: { id: 'mr-1' }, global: { plugins: [i18n], stubs: { RouterLink: true } } });
    await vi.waitFor(() => expect(w.find('[data-test=portal-maintenance-send]').exists()).toBe(true));
    await w.get('[data-test=portal-maintenance-note]').setValue('Стана полошо, водата стигна до визбата.');
    await w.get('[data-test=portal-maintenance-send]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const post = fetchMock.mock.calls[2]!;
    expect(String(post[0])).toBe('http://localhost:3001/api/portal/maintenance/mr-1/events');
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ contactId: 'c1', note: 'Стана полошо, водата стигна до визбата.' });
  });

  it('hides the writing half once the request is closed', async () => {
    const closed = { ...detail, status: 'done' as const, closedAt: '2026-09-25T12:00:00.000Z' };
    const fetchMock = vi.fn().mockResolvedValueOnce(json(me)).mockResolvedValueOnce(json(closed));
    await primedStore(fetchMock);
    const w = mount(PortalMaintenanceRequestPage, { props: { id: 'mr-1' }, global: { plugins: [i18n], stubs: { RouterLink: true } } });
    await vi.waitFor(() => expect(w.find('[data-test=portal-maintenance-status]').exists()).toBe(true));
    expect(w.get('[data-test=portal-maintenance-status]').text()).toBe('Завршено');
    expect(w.find('[data-test=portal-maintenance-send]').exists()).toBe(false);
    expect(w.find('[data-test=portal-maintenance-add-photo]').exists()).toBe(false);
  });
});
