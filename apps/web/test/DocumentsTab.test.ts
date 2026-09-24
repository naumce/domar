import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DocumentsTab from '@/components/building/DocumentsTab.vue';
import { i18n } from '@/i18n';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const doc = {
  id: 'd1', buildingId: 'b1', kind: 'minutes', title: 'Записник од собир', fileName: 'записник.pdf',
  mime: 'application/pdf', sizeBytes: 2048, sha256: 'a'.repeat(64), uploadedBy: 'u1', createdAt: '2026-09-20T09:00:00.000Z',
};

describe('DocumentsTab', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lists documents with a download link', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ rows: [doc] }));
    vi.stubGlobal('fetch', fetchMock);
    const w = mount(DocumentsTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n] } });
    await vi.waitFor(() => expect(w.text()).toContain('Записник од собир'));
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://localhost:3001/api/buildings/b1/documents');
    expect(w.get('[data-test=doc-download]').attributes('href')).toBe('http://localhost:3001/api/documents/d1/download');
    expect(w.text()).toContain('Записник'); // the kind label
  });

  it('uploads the chosen file as multipart with kind and title before it', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ rows: [] }))
      .mockResolvedValueOnce(json(doc, 201))
      .mockResolvedValueOnce(json({ rows: [doc] }));
    vi.stubGlobal('fetch', fetchMock);
    const w = mount(DocumentsTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n] } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'записник.pdf', { type: 'application/pdf' });
    const input = w.get('[data-test=doc-file]');
    Object.defineProperty(input.element, 'files', { value: [file] });
    await input.trigger('change');
    await w.get('[data-test=doc-kind]').setValue('minutes');
    await w.get('[data-test=doc-title]').setValue('Записник од собир');
    await w.get('[data-test=doc-upload]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    const [url, init] = fetchMock.mock.calls[1]! as [string, RequestInit];
    expect(String(url)).toBe('http://localhost:3001/api/buildings/b1/documents');
    expect(init.method).toBe('POST');
    expect(init.headers).toBeUndefined(); // the browser sets multipart/form-data with its own boundary
    const body = init.body as FormData;
    expect([...body.keys()]).toEqual(['kind', 'title', 'file']);
    expect(body.get('kind')).toBe('minutes');
    expect(body.get('title')).toBe('Записник од собир');
    expect((body.get('file') as File).name).toBe('записник.pdf');
  });

  it('shows a translated message when the mime is refused', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ rows: [] }))
      .mockResolvedValueOnce(json({ error: { code: 'unsupported_media_type', message: 'no' } }, 400));
    vi.stubGlobal('fetch', fetchMock);
    const w = mount(DocumentsTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n] } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const file = new File([new Uint8Array([1])], 'run.sh', { type: 'application/x-sh' });
    const input = w.get('[data-test=doc-file]');
    Object.defineProperty(input.element, 'files', { value: [file] });
    await input.trigger('change');
    await w.get('[data-test=doc-upload]').trigger('click');
    await vi.waitFor(() => expect(w.find('[data-test=doc-error]').exists()).toBe(true));
    expect(w.get('[data-test=doc-error]').text()).toBe('Тој тип на датотека не е дозволен.');
  });

  it('maps a 413 response to the file-too-large message', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ rows: [] }))
      .mockResolvedValueOnce(json({ error: { code: 'file_too_large', message: 'too big' } }, 413));
    vi.stubGlobal('fetch', fetchMock);
    const w = mount(DocumentsTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n] } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const file = new File([new Uint8Array([1, 2, 3])], 'big.pdf', { type: 'application/pdf' });
    const input = w.get('[data-test=doc-file]');
    Object.defineProperty(input.element, 'files', { value: [file] });
    await input.trigger('change');
    await w.get('[data-test=doc-upload]').trigger('click');
    await vi.waitFor(() => expect(w.find('[data-test=doc-error]').exists()).toBe(true));
    expect(w.get('[data-test=doc-error]').text()).toBe('Датотеката е поголема од 20 MB.');
  });

  it('deletes a document and refreshes the list', async () => {
    vi.stubGlobal('confirm', () => true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ rows: [doc] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({ rows: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const w = mount(DocumentsTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n] } });
    await vi.waitFor(() => expect(w.text()).toContain('Записник од собир'));
    await w.get('[data-test=doc-delete]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [url, init] = fetchMock.mock.calls[1]! as [string, RequestInit];
    expect(String(url)).toBe('http://localhost:3001/api/documents/d1');
    expect(init.method).toBe('DELETE');
    await vi.waitFor(() => expect(w.text()).not.toContain('Записник од собир'));
  });
});
