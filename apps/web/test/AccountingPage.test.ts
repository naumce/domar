import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/api/client';
import { i18n, messages } from '@/i18n';
import AccountingPage from '@/pages/AccountingPage.vue';
import { useAuthStore } from '@/stores/auth';

const flush = () => new Promise((r) => setTimeout(r, 0));

const CHART = {
  rows: [{ id: 'a1', slot: 'owner_receivable', code: '1200', name: 'Побарувања', isActive: true }],
  missing: ['revenue_service', 'vat_output'],
};
const PREVIEW = {
  from: '2026-09-01', to: '2026-10-01', buildingName: null,
  trialBalance: [
    { code: '1200', name: 'Побарувања', debitMinor: 118000, creditMinor: 0, differenceMinor: 118000 },
    { code: '7400', name: 'Приходи', debitMinor: 0, creditMinor: 100000, differenceMinor: -100000 },
    { code: '4700', name: 'ДДВ', debitMinor: 0, creditMinor: 18000, differenceMinor: -18000 },
  ],
  totals: { debitMinor: 118000, creditMinor: 118000, entryCount: 1, lineCount: 3 },
  adjustmentCount: 0, closedPeriods: [], balanced: true,
};

beforeEach(() => {
  setActivePinia(createPinia());
  // Writes (saving a slot, exporting, closing/reopening a period) are gated to owner/accountant —
  // a role that cannot use a control must not be shown it. These tests exercise those controls, so
  // they sign in as an owner, the way the app itself only shows them once a session is loaded.
  const auth = useAuthStore();
  auth.user = { id: 'me', email: 'me@f.mk', firstName: 'И', lastName: 'Т', role: 'owner', isActive: true };
  vi.restoreAllMocks();
});

function mountPage() {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/api/account-codes') return CHART as never;
    if (path === '/api/accounting/periods') return { rows: [] } as never;
    if (path === '/api/accounting/preview') return PREVIEW as never;
    if (path === '/api/buildings') return { rows: [{ id: 'b1', name: 'Партизанска 1' }] } as never;
    throw new Error(`unexpected GET ${path}`);
  });
  return mount(AccountingPage, { global: { plugins: [i18n] } });
}

describe('AccountingPage', () => {
  it('names every unmapped slot so the manager knows why the export is blocked', async () => {
    const w = mountPage();
    await flush();
    const text = w.get('[data-test=accounting-missing]').text();
    expect(text).toContain(messages.mk.accounting.slots.revenue_service);
    expect(text).toContain(messages.mk.accounting.slots.vat_output);
  });

  it('saves one slot through PUT /api/account-codes/:slot', async () => {
    const put = vi.spyOn(api, 'put').mockResolvedValue({ id: 'a2', slot: 'vat_output', code: '4700', name: 'ДДВ', isActive: true } as never);
    const w = mountPage();
    await flush();
    await w.get('[data-test=account-code-vat_output-code]').setValue('4700');
    await w.get('[data-test=account-code-vat_output-name]').setValue('ДДВ на излез');
    await w.get('[data-test=account-code-vat_output-save]').trigger('click');
    await flush();
    expect(put).toHaveBeenCalledWith('/api/account-codes/vat_output', { code: '4700', name: 'ДДВ на излез' });
  });

  it('shows a balanced trial balance in minor-unit-faithful money', async () => {
    const w = mountPage();
    await flush();
    await w.get('[data-test=accounting-from]').setValue('2026-09-01');
    await w.get('[data-test=accounting-to]').setValue('2026-10-01');
    await w.get('[data-test=accounting-preview]').trigger('click');
    await flush();
    expect(w.findAll('[data-test=trial-row]')).toHaveLength(3);
    expect(w.get('[data-test=accounting-total-debit]').text()).toBe('1.180,00 ден.');
    expect(w.find('[data-test=accounting-balanced]').exists()).toBe(true);
    expect(w.find('[data-test=accounting-unbalanced]').exists()).toBe(false);
  });

  it('turns red when the trial balance does not close', async () => {
    const w = mountPage();
    await flush();
    vi.spyOn(api, 'get').mockResolvedValue({ ...PREVIEW, totals: { ...PREVIEW.totals, creditMinor: 117000 }, balanced: false } as never);
    await w.get('[data-test=accounting-preview]').trigger('click');
    await flush();
    expect(w.find('[data-test=accounting-unbalanced]').exists()).toBe(true);
    expect(w.find('[data-test=accounting-export]').attributes('disabled')).toBeDefined();
  });

  it('shows the chart_incomplete error in Macedonian', async () => {
    const w = mountPage();
    await flush();
    vi.spyOn(api, 'get').mockRejectedValue(Object.assign(new Error('x'), { code: 'chart_incomplete' }));
    await w.get('[data-test=accounting-preview]').trigger('click');
    await flush();
    expect(w.get('[data-test=page-error]').text()).toBe(messages.mk.accounting.errors.chart_incomplete);
  });

  it('closes a period and offers to reopen it', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({
      id: 'ap1', period: '2026-09', closedAt: '2026-10-01T09:00:00.000Z', closedBy: 'u1', closedByName: 'Ана',
      debitTotalMinor: 118000, creditTotalMinor: 118000, entryCount: 1,
    } as never);
    const w = mountPage();
    await flush();
    await w.get('[data-test=accounting-period]').setValue('2026-09');
    await w.get('[data-test=accounting-close]').trigger('click');
    await flush();
    expect(post).toHaveBeenCalledWith('/api/accounting/periods/2026-09/close');
  });
});
