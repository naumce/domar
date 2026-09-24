import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import PortalFundPage from '@/pages/portal/PortalFundPage.vue';
import PortalHomePage from '@/pages/portal/PortalHomePage.vue';
import PortalInvoicesPage from '@/pages/portal/PortalInvoicesPage.vue';
import { usePortalStore } from '@/stores/portal';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const me = {
  account: { id: 'a1', email: 'marko@owner.mk' },
  links: [{ tenantId: 't1', tenantName: 'Фирма 1', contactId: 'c1', contactName: 'Марко Марков', buildings: [{ id: 'b1', name: 'Партизанска 12' }] }],
};
const invoice = {
  id: 'i1', periodId: 'p1', buildingId: 'b1', contactId: 'c1', number: 'INV-0001/2026', status: 'partially_paid', currency: 'MKD', unitIds: ['u1'],
  subtotalMinor: 224660, taxMinor: 31439, totalMinor: 256099, previousBalanceMinor: 0, amountDueMinor: 256099, reserveFundBuildingBalanceMinor: 3500000,
  paidMinor: 100000, outstandingMinor: 156099, issuedAt: '2026-09-30T00:00:00.000Z', dueAt: '2026-10-15T00:00:00.000Z', publishedAt: '2026-09-30T00:00:00.000Z',
  period: '2026-09', contact: { id: 'c1', firstName: 'Марко', lastName: 'Марков' }, building: { id: 'b1', name: 'Партизанска 12' }, createdAt: '2026-09-30T00:00:00.000Z',
};
const statement = { contact: { id: 'c1', firstName: 'Марко', lastName: 'Марков' }, building: null, rows: [], balanceMinor: 156099 };

async function primedStore(fetchMock: ReturnType<typeof vi.fn>) {
  setActivePinia(createPinia());
  vi.stubGlobal('fetch', fetchMock);
  const store = usePortalStore();
  await store.fetchMe();
  return store;
}

describe('PortalHomePage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows the manager, the buildings, the balance and the unpaid count', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(me))
      .mockResolvedValueOnce(json({ rows: [invoice], total: 1 }))
      .mockResolvedValueOnce(json(statement));
    await primedStore(fetchMock);
    const w = mount(PortalHomePage, { global: { plugins: [i18n], stubs: { RouterLink: true } } });
    await flushPromises();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(String(fetchMock.mock.calls[1]![0])).toBe('http://localhost:3001/api/portal/invoices?contactId=c1&pageSize=12');
    expect(String(fetchMock.mock.calls[2]![0])).toBe('http://localhost:3001/api/portal/statement?contactId=c1');
    expect(w.get('[data-test=portal-card-manager]').text()).toBe('Фирма 1');
    expect(w.get('[data-test=portal-card-buildings]').text()).toBe('Партизанска 12');
    expect(w.get('[data-test=portal-card-balance]').text()).toBe('1.560,99 ден.');
    expect(w.get('[data-test=portal-card-unpaid]').text()).toBe('1');
    // mk-MK short dates carry the era suffix: `15.10.2026 г.`
    expect(w.get('[data-test=portal-card-last]').text()).toBe('2026-09 · 15.10.2026 г.');
  });

  it('asks for a code when nothing is linked', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ account: { id: 'a1', email: 'x@owner.mk' }, links: [] }));
    await primedStore(fetchMock);
    const w = mount(PortalHomePage, { global: { plugins: [i18n], stubs: { RouterLink: true } } });
    await flushPromises();
    await vi.waitFor(() => expect(w.find('[data-test=portal-no-links]').exists()).toBe(true));
    expect(w.get('[data-test=portal-no-links]').text()).toBe('Сè уште немате поврзан имот. Побарајте код од вашиот управител.');
    expect(fetchMock).toHaveBeenCalledTimes(1); // nothing is fetched without a selected contact
  });
});

describe('PortalInvoicesPage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lists the invoices with their outstanding amounts', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(me)).mockResolvedValueOnce(json({ rows: [invoice], total: 1 }));
    await primedStore(fetchMock);
    const w = mount(PortalInvoicesPage, { global: { plugins: [i18n], stubs: { RouterLink: true } } });
    await flushPromises();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1]![0])).toBe('http://localhost:3001/api/portal/invoices?contactId=c1&page=1&pageSize=50');
    expect(w.get('[data-test=portal-invoice-total]').text()).toBe('2.560,99 ден.');
    expect(w.get('[data-test=portal-invoice-outstanding]').text()).toBe('1.560,99 ден.');
    expect(w.text()).toContain('INV-0001/2026');
    expect(w.text()).toContain('Делумно платена');
  });
});

describe('PortalFundPage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows both fund balances and the last 12 months of movements', async () => {
    const fund = {
      building: { id: 'b1', name: 'Партизанска 12' },
      regular: { balanceMinor: 81099, billedMinor: 839532 },
      reserve: { balanceMinor: 3550000, billedMinor: 225000 },
      transactions: [
        { id: 'p1', kind: 'expense', fund: 'regular', amountMinor: -120000, bookedAt: '2026-09-14T00:00:00.000Z', description: 'Поправка на лифт' },
        { id: 'p2', kind: 'opening', fund: 'reserve', amountMinor: 3500000, bookedAt: '2026-09-01T00:00:00.000Z', description: null },
      ],
      truncated: false,
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(json(me)).mockResolvedValueOnce(json(fund));
    await primedStore(fetchMock);
    const w = mount(PortalFundPage, { global: { plugins: [i18n], stubs: { RouterLink: true } } });
    await flushPromises();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1]![0])).toBe('http://localhost:3001/api/portal/buildings/b1/fund?contactId=c1');
    expect(w.get('[data-test=portal-fund-regular]').text()).toBe('810,99 ден.');
    expect(w.get('[data-test=portal-fund-reserve]').text()).toBe('35.500,00 ден.');
    expect(w.get('[data-test=portal-fund-billed-reserve]').text()).toBe('2.250,00 ден.');
    expect(w.findAll('[data-test=portal-fund-tx]')).toHaveLength(2);
    expect(w.findAll('[data-test=portal-fund-tx]')[0]!.text()).toContain('Поправка на лифт');
    expect(w.findAll('[data-test=portal-fund-tx]')[0]!.text()).toContain('Трошок');
    expect(w.findAll('[data-test=portal-fund-tx]')[1]!.text()).toContain('Почетно салдо');
    expect(w.find('[data-test=portal-fund-truncated]').exists()).toBe(false);
  });

  it('shows the truncation notice when the fund history was cut off', async () => {
    const fund = {
      building: { id: 'b1', name: 'Партизанска 12' },
      regular: { balanceMinor: 81099, billedMinor: 839532 },
      reserve: { balanceMinor: 3550000, billedMinor: 225000 },
      transactions: [],
      truncated: true,
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(json(me)).mockResolvedValueOnce(json(fund));
    await primedStore(fetchMock);
    const w = mount(PortalFundPage, { global: { plugins: [i18n], stubs: { RouterLink: true } } });
    await flushPromises();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(w.get('[data-test=portal-fund-truncated]').text()).toBe('Прикажани се последните 500 трансакции; постарите не се вклучени.');
  });
});
