import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import PeriodsTab from '@/components/building/PeriodsTab.vue';
import { i18n } from '@/i18n';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

describe('PeriodsTab', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('lists periods with status and posts a new period with fee in minor units', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ rows: [{ id: 'p1', period: '2026-09', status: 'published', kind: 'regular', invoiceCount: 3, totalMinor: 1064532, currency: 'MKD' }] }))
      .mockResolvedValueOnce(json({ rows: [{ id: 'tr', name: 'ДДВ 18%', rateBp: 1800, isDefault: true, isActive: true }] }))
      .mockResolvedValueOnce(json({ id: 'p2', period: '2026-10', status: 'open', invoiceCount: 0, totalMinor: 0, lines: [] }, 201))
      .mockResolvedValueOnce(json({ rows: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div/>' } }] });
    const w = mount(PeriodsTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n, router] } });
    await vi.waitFor(() => expect(w.text()).toContain('2026-09'));
    expect(w.text()).toContain(i18n.global.t('periods.status.published'));
    expect(w.text()).toContain('10.645,32 ден.');
    await w.get('[data-test=period-month]').setValue('2026-10');
    await w.get('[data-test=period-fee]').setValue('150');
    await w.get('form').trigger('submit');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    const [url, init] = fetchMock.mock.calls[2] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:3001/api/buildings/b1/periods');
    expect(JSON.parse(String(init.body))).toEqual({ period: '2026-10', managementFeeMinor: 15000, managementFeeTaxRateId: 'tr' });
  });

  it('badges an extraordinary period so it is not mistaken for the regular month', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ rows: [
        { id: 'p1', period: '2026-09', status: 'published', kind: 'regular', invoiceCount: 3, totalMinor: 1064532, currency: 'MKD' },
        { id: 'p2', period: '2026-09', status: 'published', kind: 'extraordinary', invoiceCount: 3, totalMinor: 600000, currency: 'MKD' },
      ] }))
      .mockResolvedValueOnce(json({ rows: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div/>' } }] });
    const w = mount(PeriodsTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n, router] } });
    await vi.waitFor(() => expect(w.findAll('[data-test=period-link]')).toHaveLength(2));
    const badges = w.findAll('[data-test=period-kind]');
    expect(badges).toHaveLength(1);
    expect(badges[0]!.text()).toBe(i18n.global.t('periods.kind.extraordinary'));
  });
});
