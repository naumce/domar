import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RemindersTab from '@/components/building/RemindersTab.vue';
import { i18n } from '@/i18n';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const reminder = {
  id: 'r1', buildingId: 'b1', contactId: 'c1', reason: 'consecutive', invoiceIds: ['i1', 'i2'], invoiceNumbers: ['INV-0001/2026', 'INV-0004/2026'],
  totalOutstandingMinor: 708000, channel: 'letter', status: 'pending', sentAt: null, error: null,
  contact: { id: 'c1', firstName: 'Марко', lastName: 'Марков', email: null }, createdAt: '2026-09-24T09:00:00.000Z',
};

describe('RemindersTab', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('runs the evaluation and lists what it created', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ rows: [] }))
      .mockResolvedValueOnce(json({ rows: [reminder] }))
      .mockResolvedValueOnce(json({ rows: [reminder] }));
    vi.stubGlobal('fetch', fetchMock);
    const w = mount(RemindersTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n], stubs: { RouterLink: true } } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await w.get('[data-test=reminders-run]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(String(fetchMock.mock.calls[1]![0])).toBe('http://localhost:3001/api/buildings/b1/reminders/run');
    expect(w.get('[data-test=reminders-created]').text()).toBe('Изготвени опомени: 1');
    expect(w.get('[data-test=reminder-reason]').text()).toBe('Две последователни неплатени');
    expect(w.get('[data-test=reminder-status]').text()).toBe('Чека печатење');
    expect(w.get('[data-test=reminder-total]').text()).toBe('7.080,00 ден.');
    expect(w.get('[data-test=reminder-pdf]').attributes('href')).toBe('http://localhost:3001/api/reminders/r1/pdf');
  });

  it('marks a letter reminder printed', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ rows: [reminder] }))
      .mockResolvedValueOnce(json({ ...reminder, status: 'printed', sentAt: '2026-09-25T09:00:00.000Z' }))
      .mockResolvedValueOnce(json({ rows: [{ ...reminder, status: 'printed', sentAt: '2026-09-25T09:00:00.000Z' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const w = mount(RemindersTab, { props: { buildingId: 'b1' }, global: { plugins: [i18n], stubs: { RouterLink: true } } });
    await vi.waitFor(() => expect(w.text()).toContain('Марков'));
    await w.get('[data-test=reminder-printed]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(String(fetchMock.mock.calls[1]![0])).toBe('http://localhost:3001/api/reminders/r1/printed');
    expect(w.get('[data-test=reminder-status]').text()).toBe('Испечатена');
  });
});
