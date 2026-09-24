import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { i18n } from '@/i18n';
import PeriodPage from '@/pages/PeriodPage.vue';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

const period = (kind: 'regular' | 'extraordinary', status: 'generated' | 'published') => ({
  id: 'p1', buildingId: 'b1', period: '2026-09', status, kind, distributionBasis: kind === 'extraordinary' ? 'equal' : null,
  managementFeeMinor: 0, managementFeeTaxRateBp: 0, managementFeeAppliesTo: [], numberPrefix: 'INV-', numberSuffix: '/2026',
  currency: 'MKD', issuedAt: null, dueAt: null, generatedAt: null, publishedAt: null, warnings: [], invoiceCount: 0, totalMinor: 0, lines: [],
});

function stubFetch(p: ReturnType<typeof period>) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.includes('/periods/p1') && !url.includes('/api/invoices')) return json(p);
    return json({ rows: [] });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function mountPage() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div/>' } }] });
  const w = mount(PeriodPage, { props: { id: 'b1', periodId: 'p1' }, global: { plugins: [i18n, router] } });
  await vi.waitFor(() => expect(w.find('[data-test=period-status]').exists()).toBe(true));
  return { w, router };
}

describe('PeriodPage', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('deletes an unpublished extraordinary period and goes back to the periods tab', async () => {
    const fetchMock = stubFetch(period('extraordinary', 'generated'));
    vi.stubGlobal('confirm', vi.fn(() => true));
    const { w, router } = await mountPage();
    await w.get('[data-test=period-delete]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/app/buildings/b1?tab=periods'));
    const del = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE');
    expect(del![0]).toBe('http://localhost:3001/api/buildings/b1/periods/p1');
  });

  it('offers no delete on a regular period, nor on a published extraordinary one', async () => {
    stubFetch(period('regular', 'generated'));
    const { w } = await mountPage();
    expect(w.find('[data-test=period-delete]').exists()).toBe(false);
    w.unmount();
    vi.unstubAllGlobals();
    stubFetch(period('extraordinary', 'published'));
    const second = await mountPage();
    expect(second.w.find('[data-test=period-delete]').exists()).toBe(false);
  });
});
