import { DOMWrapper, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Service } from '@/api/types';
import BuildingServicesTab from '@/components/building/BuildingServicesTab.vue';
import { i18n } from '@/i18n';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

const service: Service = { id: 's1', name: 'Cleaning', category: null, description: null, pricing: 'fixed_per_unit', defaultPriceMinor: 5000, taxRateId: null, taxRateBp: 0, appliesTo: [], recurring: true, isActive: true };

describe('BuildingServicesTab', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('validates service selection and the price override before posting', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ rows: [] }))
      .mockResolvedValueOnce(json({ rows: [service] }));
    vi.stubGlobal('fetch', fetchMock);
    const w = mount(BuildingServicesTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n] } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const body = new DOMWrapper(document.body);

    await w.get('[data-test=attach-service]').trigger('click');
    await body.get('form').trigger('submit');
    expect(body.get('[data-test=error]').text()).toBe(i18n.global.t('auth.errors.validation'));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await body.get('[data-test=attach-service-select]').setValue('s1');
    await body.get('[data-test=attach-price]').setValue('abc');
    await body.get('form').trigger('submit');
    expect(body.get('[data-test=error]').text()).toBe(i18n.global.t('auth.errors.validation'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
