import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { Service, TaxRate } from '@/api/types';
import PeriodLineForm from '@/components/billing/PeriodLineForm.vue';
import { i18n } from '@/i18n';

const services: Service[] = [{ id: 's1', name: 'Лифт', category: null, description: null, pricing: 'shared_total', defaultPriceMinor: 600000, taxRateId: 'tr', taxRateBp: 1800, appliesTo: [], recurring: true, isActive: true }];
const taxRates: TaxRate[] = [{ id: 'tr', name: 'ДДВ 18%', rateBp: 1800, isDefault: true, isActive: true }];

describe('PeriodLineForm', () => {
  it('prefills from a service and emits the API body with minor units', async () => {
    const w = mount(PeriodLineForm, { props: { services, taxRates, requireNote: false }, global: { plugins: [i18n] } });
    await w.get('[data-test=line-service]').setValue('s1');
    expect((w.get('[data-test=line-description]').element as HTMLInputElement).value).toBe('Лифт');
    expect((w.get('[data-test=line-price]').element as HTMLInputElement).value).toBe('6000,00');
    await w.get('[data-test=line-quantity]').setValue('0,5');
    await w.get('form').trigger('submit');
    expect(w.emitted('submit')![0]![0]).toEqual({ serviceId: 's1', description: 'Лифт', pricing: 'shared_total', quantity: 0.5, unitPriceMinor: 600000, taxRateId: 'tr', appliesTo: [], fund: 'regular' });
  });
  it('requires a note when editing an auto line', async () => {
    const w = mount(PeriodLineForm, { props: { services, taxRates, requireNote: true, initial: { id: 'l1', serviceId: 's1', description: 'Лифт', pricing: 'shared_total', quantity: 1, unitPriceMinor: 600000, taxRateBp: 1800, appliesTo: [], fund: 'regular', source: 'auto', note: null, sortOrder: 0 } }, global: { plugins: [i18n] } });
    await w.get('form').trigger('submit');
    expect(w.emitted('submit')).toBeUndefined();
    expect(w.text()).toContain(i18n.global.t('periods.noteRequired'));
    await w.get('[data-test=line-note]').setValue('попуст');
    await w.get('form').trigger('submit');
    expect(w.emitted('submit')![0]![0]).toMatchObject({ note: 'попуст', unitPriceMinor: 600000 });
  });
  it('omits taxRateId when the line rate is no longer active, and includes it once the user picks a rate', async () => {
    const w = mount(PeriodLineForm, { props: { services, taxRates, requireNote: false, initial: { id: 'l1', serviceId: null, description: 'Осигурување', pricing: 'fixed_per_unit', quantity: 1, unitPriceMinor: 10000, taxRateBp: 500, appliesTo: [], fund: 'regular', source: 'manual', note: null, sortOrder: 0 } }, global: { plugins: [i18n] } });
    await w.get('form').trigger('submit');
    expect(w.emitted('submit')![0]![0]).not.toHaveProperty('taxRateId');
    await w.get('[data-test=line-tax]').setValue('tr');
    await w.get('form').trigger('submit');
    expect(w.emitted('submit')![1]![0]).toMatchObject({ taxRateId: 'tr' });
  });
});
