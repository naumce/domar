import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '@/api/client';
import { i18n, messages } from '@/i18n';
import AccountingPage from '@/pages/AccountingPage.vue';
import { useAuthStore } from '@/stores/auth';

const flush = () => new Promise((r) => setTimeout(r, 0));

const CHART = {
  rows: [{ id: 'a1', slot: 'owner_receivable', code: '1200', name: 'Побарувања', isActive: true }],
  // The real shape (fix round 1, item 4): each missing slot carries why, reusing the same
  // classifier the 409 `chart_incomplete` error already used.
  missing: [{ slot: 'revenue_service', reason: 'absent' }, { slot: 'vat_output', reason: 'absent' }],
};
const FILED = {
  rows: [{
    documentId: 'd1', fileName: 'smetkovodstvo-2026-09-01-2026-10-01.zip', createdAt: '2026-10-01T09:00:00.000Z',
    from: '2026-09-01', to: '2026-10-01', buildingId: null,
    entryCount: 2, adjustmentCount: 1, debitMinor: 118000, creditMinor: 118000, sizeBytes: 2048,
  }],
};
const PREVIEW = {
  from: '2026-09-01', to: '2026-10-01', buildingName: null,
  trialBalance: [
    { code: '1200', name: 'Побарувања', debitMinor: 118000, creditMinor: 0, differenceMinor: 118000 },
    { code: '7400', name: 'Приходи', debitMinor: 0, creditMinor: 100000, differenceMinor: -100000 },
    { code: '4700', name: 'ДДВ', debitMinor: 0, creditMinor: 18000, differenceMinor: -18000 },
  ],
  totals: { debitMinor: 118000, creditMinor: 118000 },
  entryCount: 1, lineCount: 3, adjustmentCount: 0, adjustmentLineCount: 0,
  closedPeriods: [], balanced: true,
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
    if (path === '/api/accounting/exports') return FILED as never;
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
    // Always reactivates the slot (fix round 1, item 3): the same save fixes both an absent and an
    // inactive slot, so the user is never told which of the two it was.
    expect(put).toHaveBeenCalledWith('/api/account-codes/vat_output', { code: '4700', name: 'ДДВ на излез', isActive: true });
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

  // The fixture this replaces was `{ ...PREVIEW, balanced: false }`, which the API cannot produce:
  // `buildJournal` throws `unbalanced_file` before a preview can return an unbalanced one, so the red
  // banner and the disabled export button are belt and braces. The state that does reach a user is
  // the 409 — and it has to be unmissable, because no setting on this page fixes it (fix round 2,
  // item 6).
  it('shouts when the derivation itself fails, and says it is a defect to report', async () => {
    const w = mountPage();
    await flush();
    vi.spyOn(api, 'get').mockRejectedValue(new ApiError(409, 'unbalanced_entry', 'entry 3 (payment p7) is out by 5 minor units'));
    await w.get('[data-test=accounting-preview]').trigger('click');
    await flush();
    const banner = w.get('[data-test=accounting-defect]');
    expect(banner.text()).toContain(messages.mk.accounting.defect);
    expect(banner.text()).toContain(messages.mk.accounting.errors.unbalanced_entry);
    expect(banner.text()).toContain(messages.mk.accounting.defectHint);
    // Not also shown as one more ordinary red line, and no trial balance left standing beside it.
    expect(w.find('[data-test=page-error]').exists()).toBe(false);
    expect(w.findAll('[data-test=trial-row]')).toHaveLength(0);
  });

  it('lists what has already been filed, with a link that survives a window change', async () => {
    const w = mountPage();
    await flush();
    const rows = w.findAll('[data-test=accounting-filed-row]');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text()).toContain('2026-09-01');
    expect(rows[0]!.text()).toContain(messages.mk.accounting.allBuildings);
    expect(w.get('[data-test=accounting-filed-download]').attributes('href')).toContain('/api/documents/d1/download');
    await w.get('[data-test=accounting-from]').setValue('2026-01-01');
    await flush();
    expect(w.find('[data-test=accounting-filed-download]').exists()).toBe(true);
  });

  it('never claims the chart is complete when it could not be read', async () => {
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/api/account-codes') throw new Error('network down');
      if (path === '/api/accounting/periods') return { rows: [] } as never;
      if (path === '/api/accounting/exports') return { rows: [] } as never;
      if (path === '/api/buildings') return { rows: [] } as never;
      throw new Error(`unexpected GET ${path}`);
    });
    const w = mount(AccountingPage, { global: { plugins: [i18n] } });
    await flush();
    expect(w.get('[data-test=page-error]').text()).toBe(messages.mk.accounting.errors.generic);
    expect(w.find('[data-test=accounting-complete]').exists()).toBe(false);
    expect(w.find('[data-test=accounting-missing]').exists()).toBe(false);
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

// Fix round 1, item 6: the canWrite gating had no test of its own. Precedent: BuildingTabs.test.ts
// asserts what each role does and does not see, rather than only exercising the write role.
describe('AccountingPage by role', () => {
  it('shows every write control to an owner', async () => {
    const w = mountPage();
    await flush();
    expect(w.find('[data-test=account-code-vat_output-code]').exists()).toBe(true);
    expect(w.find('[data-test=account-code-vat_output-save]').exists()).toBe(true);
    expect(w.find('[data-test=accounting-period]').exists()).toBe(true);
    expect(w.find('[data-test=accounting-close]').exists()).toBe(true);
    await w.get('[data-test=accounting-preview]').trigger('click');
    await flush();
    expect(w.find('[data-test=accounting-export]').exists()).toBe(true);
  });

  it('hides every write control from a readonly user, who can still read', async () => {
    const auth = useAuthStore();
    auth.user = { id: 'me', email: 'ro@f.mk', firstName: 'Р', lastName: 'О', role: 'readonly', isActive: true };
    const w = mountPage();
    await flush();
    expect(w.find('[data-test=account-code-vat_output-code]').exists()).toBe(false);
    expect(w.find('[data-test=account-code-vat_output-save]').exists()).toBe(false);
    expect(w.find('[data-test=accounting-period]').exists()).toBe(false);
    expect(w.find('[data-test=accounting-close]').exists()).toBe(false);
    expect(w.find('[data-test=accounting-missing]').exists()).toBe(true);
    await w.get('[data-test=accounting-preview]').trigger('click');
    await flush();
    expect(w.find('[data-test=accounting-export]').exists()).toBe(false);
  });
});
