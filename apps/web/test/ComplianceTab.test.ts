import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ComplianceTab from '@/components/building/ComplianceTab.vue';
import { i18n } from '@/i18n';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

const duty = (key: string, status: string, extra: Record<string, unknown> = {}) => ({
  key, article: '42/45', status, dueAt: null, lastEvidenceAt: null, howToFix: '?tab=compliance#fund-accounts',
  count: null, label: `Наслов ${key}`, hint: `Совет ${key}`, ...extra,
});

const compliance = {
  building: { id: 'b1', name: 'Партизанска 12' },
  status: 'overdue',
  counts: { ok: 2, due: 1, overdue: 1, na: 4 },
  evaluatedAt: '2026-09-24T00:00:00.000Z',
  duties: [
    duty('invoices', 'ok', { article: '19/33', howToFix: '?tab=periods', lastEvidenceAt: '2026-09-20T00:00:00.000Z', dueAt: '2026-10-25T00:00:00.000Z' }),
    duty('reminders', 'ok', { article: '28' }),
    duty('assembly', 'n/a', { article: '37', howToFix: '?tab=compliance' }),
    duty('annual_report', 'n/a', { article: '31', howToFix: '?tab=compliance' }),
    duty('fund_transparency', 'due', { article: '45(4)', howToFix: '?tab=units', count: 0 }),
    duty('fund_accounts', 'overdue'),
    duty('handover', 'n/a', { article: '30', howToFix: '?tab=contracts' }),
    duty('extraordinary_costs', 'n/a', { article: '47(5)', howToFix: '?tab=extraordinary', count: 2 }),
  ],
};
const building = { id: 'b1', name: 'Партизанска 12', regularFundAccount: null, reserveFundAccount: null };
const events = { rows: [{ id: 'e1', buildingId: 'b1', kind: 'invoice_published', refType: 'billing_period', refId: 'p1', occurredAt: '2026-09-20T09:00:00.000Z', dueAt: null, evidence: { period: '2026-09', invoiceCount: 3 }, createdBy: null, createdAt: '2026-09-20T09:00:00.000Z' }], total: 1 };

describe('ComplianceTab', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders one card per duty with its status, article, label and fix link', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(compliance))
      .mockResolvedValueOnce(json(building))
      .mockResolvedValueOnce(json(events));
    vi.stubGlobal('fetch', fetchMock);
    const w = mount(ComplianceTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n], stubs: { RouterLink: { template: '<a :href="to"><slot /></a>', props: ['to'] } } } });
    await vi.waitFor(() => expect(w.findAll('[data-test^=compliance-card-]').length).toBeGreaterThan(0));

    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://localhost:3001/api/buildings/b1/compliance');
    expect(w.get('[data-test=compliance-status]').text()).toBe('Задоцнето');
    expect(w.findAll('[data-test^=compliance-card-]:not([data-test$=-status])')).toHaveLength(8);
    expect(w.get('[data-test=compliance-card-fund_accounts-status]').text()).toBe('Задоцнето');
    expect(w.get('[data-test=compliance-card-invoices-status]').text()).toBe('Во ред');
    expect(w.get('[data-test=compliance-card-assembly-status]').text()).toBe('Не се однесува');
    expect(w.get('[data-test=compliance-card-fund_accounts]').text()).toContain('Наслов fund_accounts');
    expect(w.get('[data-test=compliance-card-fund_accounts]').text()).toContain('чл. 42/45');
    expect(w.get('[data-test=compliance-card-invoices]').text()).toContain('20.9.2026');
    expect(w.get('[data-test=compliance-fix-invoices]').attributes('href')).toBe('/app/buildings/b1?tab=periods');
    expect(w.get('[data-test=compliance-event]').text()).toContain('Објавена пресметка');
  });

  it('saves both fund account numbers and reloads', async () => {
    const fixed = { ...compliance, status: 'due', duties: compliance.duties.map((x) => (x.key === 'fund_accounts' ? { ...x, status: 'ok' } : x)) };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(compliance))
      .mockResolvedValueOnce(json(building))
      .mockResolvedValueOnce(json(events))
      .mockResolvedValueOnce(json({ ...building, regularFundAccount: '210-0000000000-19', reserveFundAccount: '210-0000000000-96' }))
      .mockResolvedValueOnce(json(fixed))
      .mockResolvedValueOnce(json({ ...building, regularFundAccount: '210-0000000000-19', reserveFundAccount: '210-0000000000-96' }))
      .mockResolvedValueOnce(json(events));
    vi.stubGlobal('fetch', fetchMock);
    const w = mount(ComplianceTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n], stubs: { RouterLink: true } } });
    await vi.waitFor(() => expect(w.find('[data-test=fund-accounts-save]').exists()).toBe(true));

    await w.get('[data-test=fund-accounts-regular]').setValue('210-0000000000-19');
    await w.get('[data-test=fund-accounts-reserve]').setValue('210-0000000000-96');
    await w.get('[data-test=fund-accounts-save]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(7));

    const patch = fetchMock.mock.calls[3]!;
    expect(String(patch[0])).toBe('http://localhost:3001/api/buildings/b1');
    expect((patch[1] as RequestInit).method).toBe('PATCH');
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({ regularFundAccount: '210-0000000000-19', reserveFundAccount: '210-0000000000-96' });
    await vi.waitFor(() => expect(w.get('[data-test=compliance-card-fund_accounts-status]').text()).toBe('Во ред'));
  });
});
