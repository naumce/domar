import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ImportTab from '@/components/building/ImportTab.vue';
import { i18n } from '@/i18n';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const CSV = 'број;тип\n1;стан\n2;кутија\n';

const preview = {
  dryRun: true,
  rows: [{ line: 2, label: '1', floor: null, kind: 'apartment', areaM2: null, ownershipShare: null, ownerFirstName: null, ownerLastName: null, ownerEmail: null, ownerPhone: null, openingBalanceMinor: 0 }],
  errors: [{ line: 3, message: 'unknown kind: кутија' }],
  counts: { units: 1, newContacts: 0, existingContacts: 0, openingBalances: 0, conflicts: 0 },
  conflicts: [],
  hasPublishedPeriod: false,
  blocked: null,
};

describe('ImportTab', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('previews a file with a row error and then commits without dryRun', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(preview))
      .mockResolvedValueOnce(json({ ...preview, dryRun: false, errors: preview.errors }));
    vi.stubGlobal('fetch', fetchMock);

    const w = mount(ImportTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n] } });
    const input = w.get('[data-test=import-file]');
    Object.defineProperty(input.element, 'files', { value: [new File([CSV], 'units.csv', { type: 'text/csv' })] });
    await input.trigger('change');
    await w.get('[data-test=import-preview]').trigger('click');

    await vi.waitFor(() => expect(w.text()).toContain('unknown kind: кутија'));
    expect(w.get('[data-test=import-count-units]').text()).toBe('1');
    const [previewUrl, previewInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(previewUrl).toBe('http://localhost:3001/api/buildings/b1/import/units');
    expect(JSON.parse(String(previewInit.body))).toEqual({ content: CSV, mode: 'fail', dryRun: true });

    await w.get('[data-test=import-commit]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toEqual({ content: CSV, mode: 'fail' });
    await vi.waitFor(() => expect(w.find('[data-test=import-done]').exists()).toBe(true));
  });

  it('requires the force checkbox before committing against a published period', async () => {
    const blockedPreview = { ...preview, hasPublishedPeriod: true, blocked: 'period_published' as const };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(blockedPreview))
      .mockResolvedValueOnce(json({ ...blockedPreview, dryRun: false }));
    vi.stubGlobal('fetch', fetchMock);

    const w = mount(ImportTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n] } });
    const input = w.get('[data-test=import-file]');
    Object.defineProperty(input.element, 'files', { value: [new File([CSV], 'units.csv', { type: 'text/csv' })] });
    await input.trigger('change');
    await w.get('[data-test=import-preview]').trigger('click');
    await vi.waitFor(() => expect(w.find('[data-test=import-force]').exists()).toBe(true));

    expect(w.get('[data-test=import-commit]').attributes('disabled')).toBeDefined();

    await w.get('[data-test=import-force]').setValue(true);
    expect(w.get('[data-test=import-commit]').attributes('disabled')).toBeUndefined();

    await w.get('[data-test=import-commit]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, commitInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(String(commitInit.body))).toEqual({ content: CSV, mode: 'fail', force: true });
  });
});
