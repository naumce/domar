import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import PaymentForm from '@/components/billing/PaymentForm.vue';
import { i18n } from '@/i18n';

describe('PaymentForm', () => {
  it('prefills the outstanding amount and emits minor units with an ISO date', async () => {
    const w = mount(PaymentForm, { props: { outstandingMinor: 156099 }, global: { plugins: [i18n] } });
    expect((w.get('[data-test=pay-amount]').element as HTMLInputElement).value).toBe('1560,99');
    await w.get('[data-test=pay-date]').setValue('2026-10-05');
    await w.get('[data-test=pay-method]').setValue('cash');
    await w.get('[data-test=pay-reference]').setValue('уплата');
    await w.get('form').trigger('submit');
    const p = w.emitted('submit')![0]![0] as { amountMinor: number; method: string; paidAt: string; reference: string | null };
    expect(p.amountMinor).toBe(156099);
    expect(p.method).toBe('cash');
    expect(p.paidAt.startsWith('2026-10-05')).toBe(true);
    expect(p.reference).toBe('уплата');
  });
  it('rejects zero or invalid amounts', async () => {
    const w = mount(PaymentForm, { props: { outstandingMinor: null }, global: { plugins: [i18n] } });
    await w.get('[data-test=pay-amount]').setValue('0');
    await w.get('form').trigger('submit');
    expect(w.emitted('submit')).toBeUndefined();
    expect(w.text()).toContain(i18n.global.t('auth.errors.validation'));
  });
});
