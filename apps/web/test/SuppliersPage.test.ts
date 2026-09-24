import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import SuppliersPage from '@/pages/SuppliersPage.vue';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const supplier = { id: 's1', name: 'Пекара ДОО', companyNumber: null, vatNumber: null, email: null, phone: null, iban: null, notes: null, isActive: true };

describe('SuppliersPage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('toggling active sends a PATCH with only isActive', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ rows: [supplier] }))
      .mockResolvedValueOnce(json({ ...supplier, isActive: false }))
      .mockResolvedValueOnce(json({ rows: [{ ...supplier, isActive: false }] }));
    vi.stubGlobal('fetch', fetchMock);
    const w = mount(SuppliersPage, { global: { plugins: [i18n] } });
    await vi.waitFor(() => expect(w.text()).toContain('Пекара ДОО'));

    await w.get('[data-test=supplier-toggle]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    const [url, init] = fetchMock.mock.calls[1]! as [string, RequestInit];
    expect(String(url)).toBe('http://localhost:3001/api/suppliers/s1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ isActive: false });
  });
});
