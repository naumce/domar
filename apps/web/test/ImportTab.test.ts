import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import ImportTab from '@/components/building/ImportTab.vue';
import { i18n } from '@/i18n';
import { mappingKey } from '@/utils/spreadsheet';

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
    expect(w.get('[data-test=import-commit]').attributes('disabled')).toBeDefined();
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

const AOA = [
  ['Стан', 'Кат', 'Намена', 'Квадратура', 'Сопственик', 'Презиме', 'Маил'],
  ['1', '1', 'стан', '54,5', 'Марко', 'Марков', 'marko@example.mk'],
  ['2', '1', 'стан', '62', 'Ана', 'Бошковска', 'ana@example.mk'],
];

const HEADER = 'број;кат;тип;површина;удел;име;презиме;е-пошта;телефон;почетно салдо';
const MAPPED_CSV = `${HEADER}\n`
  + '1;1;стан;54,5;;Марко;Марков;;;\n'
  + '2;1;стан;62;;Ана;Бошковска;;;\n';

function xlsxFile(): File {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(AOA), 'Единици');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new File([new Uint8Array(buf)], 'единици.xlsx');
}

async function choose(w: ReturnType<typeof mount>, file: File) {
  const input = w.get('[data-test=import-file]');
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
  await input.trigger('change');
}

describe('ImportTab column mapping', () => {
  afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

  it('reads an xlsx, prefills what it recognises and previews the canonical CSV', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(preview));
    vi.stubGlobal('fetch', fetchMock);

    const w = mount(ImportTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n] } });
    await choose(w, xlsxFile());
    // The mapping step opens by itself for a spreadsheet.
    await vi.waitFor(() => expect(w.find('[data-test=import-map-label]').exists()).toBe(true));

    // "Кат" and "Презиме" are header aliases, so they arrive already mapped.
    expect((w.get('[data-test=import-map-floor]').element as HTMLSelectElement).value).toBe('1');
    expect((w.get('[data-test=import-map-ownerLastName]').element as HTMLSelectElement).value).toBe('5');
    expect((w.get('[data-test=import-map-label]').element as HTMLSelectElement).value).toBe('');

    await w.get('[data-test=import-map-label]').setValue('0');
    await w.get('[data-test=import-map-kind]').setValue('2');
    await w.get('[data-test=import-map-areaM2]').setValue('3');
    await w.get('[data-test=import-map-ownerFirstName]').setValue('4');
    expect(w.get('[data-test=import-unmapped]').text()).toContain('Маил');

    await w.get('[data-test=import-map-apply]').trigger('click');
    await vi.waitFor(() => expect(w.find('[data-test=import-map-ready]').exists()).toBe(true));

    await w.get('[data-test=import-preview]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ content: MAPPED_CSV, mode: 'fail', dryRun: true });
  });

  it('will not preview or commit a spreadsheet until the mapping has been applied', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(preview));
    vi.stubGlobal('fetch', fetchMock);

    const w = mount(ImportTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n] } });
    await choose(w, xlsxFile());
    await vi.waitFor(() => expect(w.find('[data-test=import-map-label]').exists()).toBe(true));
    // Previewing here would send the xlsx bytes as CSV text.
    expect(w.get('[data-test=import-preview]').attributes('disabled')).toBeDefined();
    expect(w.get('[data-test=import-commit]').attributes('disabled')).toBeDefined();

    await w.get('[data-test=import-map-label]').setValue('0');
    await w.get('[data-test=import-map-kind]').setValue('2');
    await w.get('[data-test=import-map-apply]').trigger('click');

    await vi.waitFor(() => expect(w.get('[data-test=import-preview]').attributes('disabled')).toBeUndefined());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses two targets on one column and never sends anything', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(preview));
    vi.stubGlobal('fetch', fetchMock);

    const w = mount(ImportTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n] } });
    await choose(w, xlsxFile());
    await vi.waitFor(() => expect(w.find('[data-test=import-map-label]').exists()).toBe(true));

    await w.get('[data-test=import-map-label]').setValue('0');
    await w.get('[data-test=import-map-kind]').setValue('0');
    await w.get('[data-test=import-map-apply]').trigger('click');

    expect(w.get('[data-test=import-map-error]').text()).toContain('иста колона');
    expect(w.find('[data-test=import-map-ready]').exists()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('names the required targets when they are missing', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const w = mount(ImportTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n] } });
    await choose(w, xlsxFile());
    await vi.waitFor(() => expect(w.find('[data-test=import-map-label]').exists()).toBe(true));

    await w.get('[data-test=import-map-apply]').trigger('click');
    expect(w.get('[data-test=import-map-error]').text()).toContain('број');
  });

  it('remembers a mapping per header set and recalls it by header name', async () => {
    const key = mappingKey(AOA[0]!);
    expect(key).toMatch(/^domar\.importMapping\.[0-9a-f]{8}$/);
    expect(mappingKey(['b', 'a'])).toBe(mappingKey(['A', ' b '])); // sorted, trimmed, case-folded
    localStorage.setItem(key, JSON.stringify({ label: 'Стан', kind: 'Намена', areaM2: 'Квадратура', ownerFirstName: 'Сопственик' }));

    const fetchMock = vi.fn().mockResolvedValue(json(preview));
    vi.stubGlobal('fetch', fetchMock);
    const w = mount(ImportTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n] } });
    await choose(w, xlsxFile());
    await vi.waitFor(() => expect(w.find('[data-test=import-map-label]').exists()).toBe(true));

    expect((w.get('[data-test=import-map-label]').element as HTMLSelectElement).value).toBe('0');
    expect((w.get('[data-test=import-map-kind]').element as HTMLSelectElement).value).toBe('2');

    await w.get('[data-test=import-map-apply]').trigger('click');
    await w.get('[data-test=import-preview]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).content).toBe(MAPPED_CSV);
  });

  it('maps a CSV whose header the parser does not know', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(preview));
    vi.stubGlobal('fetch', fetchMock);

    const w = mount(ImportTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n] } });
    await choose(w, new File(['Стан;Кат;Намена\n1;1;стан\n'], 'units.csv', { type: 'text/csv' }));
    expect(w.find('[data-test=import-map-label]').exists()).toBe(false); // the CSV path stays as it was

    await w.get('[data-test=import-map-open]').trigger('click');
    await vi.waitFor(() => expect(w.find('[data-test=import-map-label]').exists()).toBe(true));
    await w.get('[data-test=import-map-label]').setValue('0');
    await w.get('[data-test=import-map-kind]').setValue('2');
    await w.get('[data-test=import-map-apply]').trigger('click');
    await w.get('[data-test=import-preview]').trigger('click');

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).content).toBe(`${HEADER}\n1;1;стан;;;;;;;\n`);
  });
});
