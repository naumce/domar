import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MaintenanceRequest, MaintenanceRow, User } from '@/api/types';
import MaintenanceTab from '@/components/building/MaintenanceTab.vue';
import { i18n } from '@/i18n';
import { useAuthStore } from '@/stores/auth';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

const units = { rows: [{ id: 'u1', buildingId: 'b1', label: '1', floor: null, kind: 'apartment', areaM2: 50, ownershipShare: null, ownerContactId: 'c1', attachedToUnitId: null, owner: { id: 'c1', firstName: 'Марко', lastName: 'Марков' } }] };
const users: { rows: User[] } = {
  rows: [
    { id: 'usr-1', email: 'stefan@f.mk', firstName: 'Стефан', lastName: 'Стефановски', role: 'technician', isActive: true },
    { id: 'usr-2', email: 'ro@f.mk', firstName: 'Р', lastName: 'О', role: 'readonly', isActive: true },
  ],
};
const suppliers = { rows: [{ id: 'sup-1', name: 'Водовод Инженеринг ДООЕЛ', companyNumber: null, vatNumber: null, email: null, phone: null, iban: null, notes: null, isActive: true }] };

const row = (over: Partial<MaintenanceRow> = {}): MaintenanceRow => ({
  id: 'mr-1', buildingId: 'b1', unitId: 'u1', unitLabel: '1',
  title: 'Протекува цевка во визбата', category: 'plumbing', priority: 'high', status: 'new',
  reporterName: 'Марко Марков', reporterKind: 'owner',
  assigneeUserId: null, assigneeName: null, supplierId: null, supplierName: null,
  fund: null, costMinor: null, expenseId: null, photoCount: 1,
  closedAt: null, createdAt: '2026-09-25T09:00:00.000Z', updatedAt: '2026-09-25T09:00:00.000Z',
  ...over,
});
const detail = (over: Partial<MaintenanceRequest> = {}): MaintenanceRequest => ({
  ...row(), description: 'Вода тече покрај вертикалата под влезот.',
  photos: [{ documentId: 'doc-1', title: 'voda.png', fileName: 'voda.png', mime: 'image/png', sizeBytes: 1024, uploadedByName: 'Марко Марков', createdAt: '2026-09-25T09:00:00.000Z' }],
  events: [{ id: 'ev-1', kind: 'created', fromStatus: null, toStatus: 'new', note: 'Протекува цевка во визбата', visibility: 'owner', authorName: 'Марко Марков', authorKind: 'owner', createdAt: '2026-09-25T09:00:00.000Z' }],
  ...over,
});

function signIn(role: User['role']) {
  setActivePinia(createPinia());
  const auth = useAuthStore();
  auth.user = { id: 'me', email: 'me@f.mk', firstName: 'И', lastName: 'Т', role, isActive: true };
  return auth;
}

/** units, users, suppliers, board — the four calls every mount makes, in that order. */
const boot = (rows: MaintenanceRow[]) => [json(units), json(users), json(suppliers), json({ rows })];

async function mountTab(responses: Response[], role: User['role'] = 'owner') {
  signIn(role);
  const fetchMock = vi.fn();
  for (const r of responses) fetchMock.mockResolvedValueOnce(r);
  vi.stubGlobal('fetch', fetchMock);
  const w = mount(MaintenanceTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n], stubs: { teleport: true } } }); // MaintenancePanel's close-with-cost dialog teleports to body; the stub renders it inline so wrapper.get() can see it
  await vi.waitFor(() => expect(w.find('[data-test=maintenance-create]').exists() || w.find('[data-test=maintenance-column-new]').exists()).toBe(true));
  await flushPromises();
  return { w, fetchMock };
}

describe('MaintenanceTab', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('draws one column per status and counts the cards', async () => {
    const { w } = await mountTab(boot([row(), row({ id: 'mr-2', status: 'done', title: 'Изгорена сијалица', category: 'electrical' })]));
    expect(w.get('[data-test=maintenance-count-new]').text()).toBe('1');
    expect(w.get('[data-test=maintenance-count-done]').text()).toBe('1');
    expect(w.get('[data-test=maintenance-count-assigned]').text()).toBe('0');
    expect(w.findAll('[data-test=maintenance-card]')).toHaveLength(2);
    expect(w.get('[data-test=maintenance-column-new]').text()).toContain('Протекува цевка во визбата');
    expect(w.get('[data-test=maintenance-column-new]').text()).toContain('Водовод');
  });

  it('creates a request with the typed values', async () => {
    const { w, fetchMock } = await mountTab([...boot([]), json(detail()), json({ rows: [row()] })]);
    await w.get('[data-test=maintenance-title]').setValue('Протекува цевка во визбата');
    await w.get('[data-test=maintenance-description]').setValue('Вода тече покрај вертикалата под влезот.');
    await w.get('[data-test=maintenance-category]').setValue('plumbing');
    await w.get('[data-test=maintenance-priority]').setValue('high');
    await w.get('[data-test=maintenance-unit]').setValue('u1');
    await w.get('[data-test=maintenance-create]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));

    const post = fetchMock.mock.calls[4]!;
    expect(String(post[0])).toBe('http://localhost:3001/api/buildings/b1/maintenance');
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({
      title: 'Протекува цевка во визбата', description: 'Вода тече покрај вертикалата под влезот.',
      category: 'plumbing', priority: 'high', unitId: 'u1',
    });
  });

  it('opens a card and shows its feed, its photo and its description', async () => {
    const { w, fetchMock } = await mountTab([...boot([row()]), json(detail())]);
    await w.get('[data-test=maintenance-card]').trigger('click');
    await vi.waitFor(() => expect(w.find('[data-test=maintenance-panel]').exists()).toBe(true));
    expect(String(fetchMock.mock.calls[4]![0])).toBe('http://localhost:3001/api/maintenance-requests/mr-1');
    expect(w.get('[data-test=maintenance-panel]').text()).toContain('Вода тече покрај вертикалата под влезот.');
    expect(w.get('[data-test=maintenance-panel-status]').text()).toBe('Ново');
    expect(w.findAll('[data-test=maintenance-event]')).toHaveLength(1);
    const photo = w.get('[data-test=maintenance-photo]');
    expect(photo.attributes('href')).toBe('http://localhost:3001/api/maintenance-requests/mr-1/photos/doc-1');
  });

  it('triages and assigns from the panel', async () => {
    const triaged = detail({ status: 'triaged' });
    const assigned = detail({ status: 'assigned', assigneeUserId: 'usr-1', assigneeName: 'Стефан Стефановски', supplierId: 'sup-1', supplierName: 'Водовод Инженеринг ДООЕЛ' });
    const { w, fetchMock } = await mountTab([
      ...boot([row()]), json(detail()),
      json(triaged), json({ rows: [row({ status: 'triaged' })] }),
      json(assigned), json({ rows: [row({ status: 'assigned' })] }),
    ]);
    await w.get('[data-test=maintenance-card]').trigger('click');
    await vi.waitFor(() => expect(w.find('[data-test=maintenance-triage]').exists()).toBe(true));
    await w.get('[data-test=maintenance-triage]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(7));

    const status = fetchMock.mock.calls[5]!;
    expect(String(status[0])).toBe('http://localhost:3001/api/maintenance-requests/mr-1/status');
    expect(JSON.parse(String((status[1] as RequestInit).body))).toEqual({ status: 'triaged' });

    // Only assignable roles are offered: `readonly` is not in the list.
    const options = w.get('[data-test=maintenance-assignee]').findAll('option').map((o) => o.attributes('value'));
    expect(options).toEqual(['', 'usr-1']);
    await w.get('[data-test=maintenance-assignee]').setValue('usr-1');
    await w.get('[data-test=maintenance-supplier]').setValue('sup-1');
    await w.get('[data-test=maintenance-assign]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(9));
    const assign = fetchMock.mock.calls[7]!;
    expect(String(assign[0])).toBe('http://localhost:3001/api/maintenance-requests/mr-1/assign');
    expect(JSON.parse(String((assign[1] as RequestInit).body))).toEqual({ assigneeUserId: 'usr-1', supplierId: 'sup-1' });
  });

  it('closes with a cost, sending the typed amount as minor units', async () => {
    const started = detail({ status: 'in_progress', assigneeUserId: 'usr-1', assigneeName: 'Стефан Стефановски' });
    const closed = detail({ status: 'done', costMinor: 1_200_000, fund: 'reserve', expenseId: 'exp-1', closedAt: '2026-09-25T12:00:00.000Z' });
    const { w, fetchMock } = await mountTab([
      ...boot([row({ status: 'in_progress' })]), json(started),
      json(closed), json({ rows: [row({ status: 'done' })] }),
    ]);
    await w.get('[data-test=maintenance-card]').trigger('click');
    await vi.waitFor(() => expect(w.find('[data-test=maintenance-close-open]').exists()).toBe(true));
    await w.get('[data-test=maintenance-close-open]').trigger('click');
    await w.get('[data-test=maintenance-close-fund]').setValue('reserve');
    await w.get('[data-test=maintenance-close-amount]').setValue('12.000,00');
    await w.get('[data-test=maintenance-close-supplier]').setValue('sup-1');
    await w.get('[data-test=maintenance-close-note]').setValue('Заменета спојка.');
    await w.get('[data-test=maintenance-close-submit]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(7));

    const close = fetchMock.mock.calls[5]!;
    expect(String(close[0])).toBe('http://localhost:3001/api/maintenance-requests/mr-1/status');
    expect(JSON.parse(String((close[1] as RequestInit).body))).toEqual({
      status: 'done', note: 'Заменета спојка.', visibility: 'owner',
      cost: { fund: 'reserve', costMinor: 1_200_000, supplierId: 'sup-1' },
    });
  });

  it('refuses to send a close whose amount is not an amount', async () => {
    const started = detail({ status: 'in_progress' });
    const { w, fetchMock } = await mountTab([...boot([row({ status: 'in_progress' })]), json(started)]);
    await w.get('[data-test=maintenance-card]').trigger('click');
    await vi.waitFor(() => expect(w.find('[data-test=maintenance-close-open]').exists()).toBe(true));
    await w.get('[data-test=maintenance-close-open]').trigger('click');
    await w.get('[data-test=maintenance-close-amount]').setValue('дванаесет илјади');
    await w.get('[data-test=maintenance-close-submit]').trigger('click');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(5); // nothing was sent
    expect(w.get('[data-test=maintenance-error]').text()).toBe('Проверете ги внесените податоци.');
  });

  it('closes without a cost through its own button', async () => {
    const started = detail({ status: 'in_progress' });
    const { w, fetchMock } = await mountTab([
      ...boot([row({ status: 'in_progress' })]), json(started),
      json(detail({ status: 'done' })), json({ rows: [row({ status: 'done' })] }),
    ]);
    await w.get('[data-test=maintenance-card]').trigger('click');
    await vi.waitFor(() => expect(w.find('[data-test=maintenance-close-free]').exists()).toBe(true));
    await w.get('[data-test=maintenance-close-free]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(7));
    expect(JSON.parse(String((fetchMock.mock.calls[5]![1] as RequestInit).body))).toEqual({ status: 'done', cost: null });
  });

  it('shows a technician only the buttons they may press', async () => {
    const assigned = detail({ status: 'assigned', assigneeUserId: 'usr-1', assigneeName: 'Стефан Стефановски' });
    const { w } = await mountTab([...boot([row({ status: 'assigned' })]), json(assigned)], 'technician');
    await w.get('[data-test=maintenance-card]').trigger('click');
    await vi.waitFor(() => expect(w.find('[data-test=maintenance-panel]').exists()).toBe(true));
    expect(w.find('[data-test=maintenance-start]').exists()).toBe(true);
    expect(w.find('[data-test=maintenance-close-free]').exists()).toBe(true);
    expect(w.find('[data-test=maintenance-note-add]').exists()).toBe(true);
    expect(w.find('[data-test=maintenance-photo-upload]').exists()).toBe(true);
    // The three that book money or hand out work are not rendered at all.
    expect(w.find('[data-test=maintenance-close-open]').exists()).toBe(false);
    expect(w.find('[data-test=maintenance-assign]').exists()).toBe(false);
    expect(w.find('[data-test=maintenance-triage]').exists()).toBe(false);
    expect(w.find('[data-test=maintenance-create]').exists()).toBe(false);
  });

  it('adds an owner-visible note', async () => {
    const { w, fetchMock } = await mountTab([
      ...boot([row()]), json(detail()),
      json(detail()), json({ rows: [row()] }),
    ]);
    await w.get('[data-test=maintenance-card]').trigger('click');
    await vi.waitFor(() => expect(w.find('[data-test=maintenance-note]').exists()).toBe(true));
    await w.get('[data-test=maintenance-note]').setValue('Мајсторот доаѓа утре во 9.');
    await w.get('[data-test=maintenance-note-visibility]').setValue('owner');
    await w.get('[data-test=maintenance-note-add]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(7));
    const post = fetchMock.mock.calls[5]!;
    expect(String(post[0])).toBe('http://localhost:3001/api/maintenance-requests/mr-1/events');
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ note: 'Мајсторот доаѓа утре во 9.', visibility: 'owner' });
  });

  it('filters the board through the query string', async () => {
    const { w, fetchMock } = await mountTab([...boot([row()]), json({ rows: [] })]);
    await w.get('[data-test=maintenance-filter-status]').setValue('done');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    expect(String(fetchMock.mock.calls[4]![0])).toBe('http://localhost:3001/api/buildings/b1/maintenance?status=done');
  });

  it('turns a 409 from the server into the Macedonian sentence for it', async () => {
    const { w } = await mountTab([
      ...boot([row()]), json(detail()),
      json({ error: { code: 'status_locked', message: 'x' } }, 409),
    ]);
    await w.get('[data-test=maintenance-card]').trigger('click');
    await vi.waitFor(() => expect(w.find('[data-test=maintenance-triage]').exists()).toBe(true));
    await w.get('[data-test=maintenance-triage]').trigger('click');
    await vi.waitFor(() => expect(w.find('[data-test=maintenance-error]').exists()).toBe(true));
    expect(w.get('[data-test=maintenance-error]').text()).toBe('Статусот веќе е променет од некој друг. Освежете ја страницата.');
  });
});
