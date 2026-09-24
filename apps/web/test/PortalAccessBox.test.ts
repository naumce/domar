import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PortalAccessBox from '@/components/contacts/PortalAccessBox.vue';
import { i18n } from '@/i18n';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

describe('PortalAccessBox', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('issues a code, shows it once and reports the new status', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ status: 'none' }))
      .mockResolvedValueOnce(json({ code: 'Ab3kM9xQ', expiresAt: '2026-10-18T09:00:00.000Z', emailed: true }))
      .mockResolvedValueOnce(json({ status: 'invited', expiresAt: '2026-10-18T09:00:00.000Z' }));
    vi.stubGlobal('fetch', fetchMock);
    const w = mount(PortalAccessBox, { props: { contactId: 'c1' }, global: { plugins: [i18n] } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://localhost:3001/api/contacts/c1/portal-status');
    expect(w.get('[data-test=portal-status]').text()).toBe('Нема пристап');

    await w.get('[data-test=portal-issue]').trigger('click');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(String(fetchMock.mock.calls[1]![0])).toBe('http://localhost:3001/api/contacts/c1/portal-invite');
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
    expect(w.get('[data-test=portal-issued-code]').text()).toBe('Ab3kM9xQ');
    expect(w.get('[data-test=portal-code-emailed]').text()).toBe('Кодот е испратен и по е-пошта.');
    expect(w.get('[data-test=portal-status]').text()).toBe('Испратен код');
    expect(w.get('[data-test=portal-expires]').text()).toBe('18.10.2026 г.'); // mk-MK short date

    await w.get('[data-test=portal-code-dismiss]').trigger('click');
    expect(w.find('[data-test=portal-issued-code]').exists()).toBe(false);
  });

  it('copies the code to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    // Define the property rather than replacing `navigator`: jsdom's navigator is used by Vue itself.
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ status: 'none' }))
      .mockResolvedValueOnce(json({ code: 'Ab3kM9xQ', expiresAt: '2026-10-18T09:00:00.000Z', emailed: false }))
      .mockResolvedValueOnce(json({ status: 'invited', expiresAt: '2026-10-18T09:00:00.000Z' })));
    const w = mount(PortalAccessBox, { props: { contactId: 'c1' }, global: { plugins: [i18n] } });
    await w.get('[data-test=portal-issue]').trigger('click');
    await vi.waitFor(() => expect(w.find('[data-test=portal-issued-code]').exists()).toBe(true));
    expect(w.get('[data-test=portal-code-emailed]').text()).toBe('Контактот нема е-пошта — предајте му го кодот лично.');
    await w.get('[data-test=portal-code-copy]').trigger('click');
    await vi.waitFor(() => expect(w.find('[data-test=portal-code-copied]').exists()).toBe(true));
    expect(writeText).toHaveBeenCalledWith('Ab3kM9xQ');
  });

  it('shows a linked owner and offers a fresh code anyway', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ status: 'linked', linkedAt: '2026-11-20T09:00:00.000Z' })));
    const w = mount(PortalAccessBox, { props: { contactId: 'c1' }, global: { plugins: [i18n] } });
    await vi.waitFor(() => expect(w.get('[data-test=portal-status]').text()).toBe('Поврзан'));
    expect(w.text()).toContain('20.11.2026 г.');
    expect(w.get('[data-test=portal-issue]').text()).toBe('Издади нов код');
  });

  it('shows the generic error when the API refuses', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ status: 'none' }))
      .mockResolvedValueOnce(json({ error: { code: 'forbidden', message: 'Not allowed' } }, 403)));
    const w = mount(PortalAccessBox, { props: { contactId: 'c1' }, global: { plugins: [i18n] } });
    await w.get('[data-test=portal-issue]').trigger('click');
    await vi.waitFor(() => expect(w.find('[data-test=portal-access-error]').exists()).toBe(true));
    expect(w.get('[data-test=portal-access-error]').text()).toBe('Настана грешка');
  });
});
