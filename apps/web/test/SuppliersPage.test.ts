import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import SuppliersPage from '@/pages/SuppliersPage.vue';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const supplier = { id: 's1', name: 'Пекара ДОО', companyNumber: null, vatNumber: null, email: null, phone: null, iban: null, notes: null, isActive: true, accountCodeId: null };
// The page also reads the chart, to offer the supplier's own expense account by code rather than by id.
const CHART = {
  rows: [
    { id: 'ac1', slot: 'expense_default', code: '4000', name: 'Трошоци', isActive: true },
    { id: 'ac2', slot: 'cash_regular', code: '1000', name: 'Сметка', isActive: false },
  ],
  missing: [],
};

/** Routed by path rather than by call order: the page issues two GETs before any write. */
function stubFetch(onWrite: (url: string, init: RequestInit) => Response) {
  const mock = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/account-codes')) return json(CHART);
    if (init?.method && init.method !== 'GET') return onWrite(u, init);
    return json({ rows: [supplier] });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}
const writes = (mock: ReturnType<typeof stubFetch>) =>
  mock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method && (init as RequestInit).method !== 'GET');

describe('SuppliersPage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('toggling active sends a PATCH with only isActive', async () => {
    const fetchMock = stubFetch(() => json({ ...supplier, isActive: false }));
    const w = mount(SuppliersPage, { global: { plugins: [i18n] } });
    await vi.waitFor(() => expect(w.text()).toContain('Пекара ДОО'));

    await w.get('[data-test=supplier-toggle]').trigger('click');
    await vi.waitFor(() => expect(writes(fetchMock)).toHaveLength(1));

    const [url, init] = writes(fetchMock)[0]! as [string, RequestInit];
    expect(String(url)).toBe('http://localhost:3001/api/suppliers/s1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ isActive: false });
  });

  // Spec §3: without this control the mapping is API-only and every expense books to expense_default.
  it('offers the chart\'s own codes and sends the chosen account id', async () => {
    const fetchMock = stubFetch(() => json({ ...supplier, accountCodeId: 'ac1' }));
    // ModalDialog teleports to body; the stub renders it inline so wrapper.get() can see the form.
    const w = mount(SuppliersPage, { global: { plugins: [i18n], stubs: { teleport: true } } });
    await vi.waitFor(() => expect(w.text()).toContain('Пекара ДОО'));

    await w.get('[data-test=add-supplier]').trigger('click');
    const select = w.get('[data-test=supplier-account-code]');
    // Only usable codes, and named by their code, not by an id nobody knows.
    const options = select.findAll('option');
    expect(options).toHaveLength(2);
    expect(options[1]!.text()).toContain('4000 — Трошоци');

    await w.get('[data-test=supplier-name]').setValue('Нов добавувач');
    await select.setValue('ac1');
    await w.get('[data-test=supplier-submit]').trigger('click');
    await vi.waitFor(() => expect(writes(fetchMock)).toHaveLength(1));

    const [url, init] = writes(fetchMock)[0]! as [string, RequestInit];
    expect(String(url)).toBe('http://localhost:3001/api/suppliers');
    expect(JSON.parse(init.body as string)).toMatchObject({ name: 'Нов добавувач', accountCodeId: 'ac1' });
  });
});
