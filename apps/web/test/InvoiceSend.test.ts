import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { i18n } from '@/i18n';
import InvoicePage from '@/pages/InvoicePage.vue';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const invoice = {
  id: 'i1', periodId: 'p1', buildingId: 'b1', contactId: 'c1', number: 'INV-0001/2026', status: 'published', currency: 'MKD', unitIds: [],
  subtotalMinor: 300000, taxMinor: 54000, totalMinor: 354000, previousBalanceMinor: 0, amountDueMinor: 354000,
  reserveFundBuildingBalanceMinor: 0, paidMinor: 0, outstandingMinor: 354000,
  issuedAt: '2026-09-01T00:00:00.000Z', dueAt: '2026-09-16T00:00:00.000Z', publishedAt: '2026-09-01T00:00:00.000Z', period: '2026-09',
  contact: { id: 'c1', kind: 'person', firstName: 'Марко', lastName: 'Марков', email: 'marko@test.mk', address: null, companyNumber: null, vatNumber: null },
  building: { id: 'b1', name: 'Партизанска 12', address: 'Партизанска 12', city: 'Скопје', postalCode: '1000', regularFundAccount: null, reserveFundAccount: null },
  lines: [], payments: [], createdAt: '2026-09-01T00:00:00.000Z',
};
const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:rest(.*)', component: { template: '<div />' } }] });

describe('InvoicePage send by email', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts the send request and shows the sent state', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(invoice))
      .mockResolvedValueOnce(json({ id: 'i1', status: 'sent', to: 'marko@test.mk', error: null }));
    vi.stubGlobal('fetch', fetchMock);
    await router.push('/app/invoices/i1');
    await router.isReady();
    const w = mount(InvoicePage, { props: { id: 'i1' }, global: { plugins: [i18n, router] } });
    await vi.waitFor(() => expect(w.text()).toContain('INV-0001/2026'));
    await w.get('[data-test=send-email]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1]![0])).toBe('http://localhost:3001/api/invoices/i1/send');
    await vi.waitFor(() => expect(w.get('[data-test=send-email-status]').text()).toBe('Испратено'));
  });

  it('refuses when the owner has no email', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ ...invoice, contact: { ...invoice.contact, email: null } }));
    vi.stubGlobal('fetch', fetchMock);
    const w = mount(InvoicePage, { props: { id: 'i1' }, global: { plugins: [i18n, router] } });
    await vi.waitFor(() => expect(w.text()).toContain('INV-0001/2026'));
    expect(w.get('[data-test=send-email]').attributes('disabled')).toBeDefined();
    expect(w.get('[data-test=send-email-status]').text()).toBe('Сопственикот нема е-пошта.');
  });
});
