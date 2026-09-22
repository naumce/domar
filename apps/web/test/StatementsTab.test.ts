import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import StatementsTab from '@/components/building/StatementsTab.vue';
import { i18n } from '@/i18n';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

describe('StatementsTab', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('lists statements, loads lines and posts a confirm with the suggested invoice', async () => {
    const line = { id: 'l1', statementId: 's1', lineNo: 1, bookedAt: '2026-10-05T12:00:00.000Z', amountMinor: 354057, counterparty: 'Boskovski', reference: 'uplata', matchStatus: 'suggested', confidence: 'likely', suggestedInvoice: { id: 'i2', number: 'INV-0002/2026', contactLastName: 'Бошковски', outstandingMinor: 354057 }, payment: null };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ rows: [{ id: 's1', buildingId: 'b1', filename: 'izvod.csv', format: 'csv', accountNumber: null, lineCount: 1, matchedCount: 0, skippedCount: 0, importedAt: '2026-10-05T12:00:00.000Z' }] }))
      .mockResolvedValueOnce(json({ rows: [] })) // open invoices
      .mockResolvedValueOnce(json({ id: 's1', lines: [line] }))
      .mockResolvedValueOnce(json({ ...line, matchStatus: 'matched', confidence: 'manual', payment: { id: 'p1', amountMinor: 354057, status: 'completed' } }))
      .mockResolvedValueOnce(json({ id: 's1', lines: [{ ...line, matchStatus: 'matched' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const w = mount(StatementsTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n] } });
    await vi.waitFor(() => expect(w.text()).toContain('izvod.csv'));
    await w.get('[data-test=stmt-row]').trigger('click');
    await vi.waitFor(() => expect(w.text()).toContain('INV-0002/2026'));
    await w.get('[data-test=line-confirm]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    const [url, init] = fetchMock.mock.calls[3] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:3001/api/statement-lines/l1/confirm');
    expect(JSON.parse(String(init.body))).toEqual({ invoiceId: 'i2' });
  });
});
