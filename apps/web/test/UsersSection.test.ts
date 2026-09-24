import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@/api/types';
import UsersSection from '@/components/settings/UsersSection.vue';
import { i18n } from '@/i18n';
import { useAuthStore } from '@/stores/auth';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const owner = { id: 'u1', email: 'owner@firma.mk', firstName: 'Ана', lastName: 'Тестова', role: 'owner', isActive: true };
const sara = { id: 'u2', email: 'sara@firma.mk', firstName: 'Сара', lastName: 'Стојанова', role: 'accountant', isActive: true };

describe('UsersSection', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows the temporary password once after creating a user', async () => {
    setActivePinia(createPinia());
    useAuthStore().user = owner as User;

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ rows: [owner] }))
      .mockResolvedValueOnce(json({ user: sara, temporaryPassword: 'Ab3kMn9pQr2sTu4v' }, 201))
      .mockResolvedValueOnce(json({ rows: [owner, sara] }));
    vi.stubGlobal('fetch', fetchMock);

    const w = mount(UsersSection, { global: { plugins: [i18n], stubs: { teleport: true } } }); // ModalDialog teleports to body; the stub renders it inline so wrapper.get() can see the form
    await vi.waitFor(() => expect(w.text()).toContain('owner@firma.mk'));

    // the acting owner's own row shows the self hint instead of toggle/reset actions
    expect(w.get('[data-test=user-self]').text()).toBe(i18n.global.t('users.self'));
    expect(w.find('[data-test=user-toggle]').exists()).toBe(false);
    expect(w.find('[data-test=user-reset]').exists()).toBe(false);

    await w.get('[data-test=users-add]').trigger('click');
    await w.get('[data-test=user-email]').setValue('sara@firma.mk');
    await w.get('[data-test=user-firstName]').setValue('Сара');
    await w.get('[data-test=user-lastName]').setValue('Стојанова');
    await w.get('[data-test=user-role]').setValue('accountant');
    await w.get('[data-test=user-submit]').trigger('click');

    await vi.waitFor(() => expect(w.get('[data-test=temp-password]').text()).toBe('Ab3kMn9pQr2sTu4v'));
    expect(w.find('[data-test=temp-copy]').exists()).toBe(true);
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:3001/api/users');
    expect(JSON.parse(String(init.body))).toEqual({ email: 'sara@firma.mk', firstName: 'Сара', lastName: 'Стојанова', role: 'accountant' });
    await vi.waitFor(() => expect(w.text()).toContain('sara@firma.mk'));
    // sara is not the acting user, so her row gets real actions, not the self hint
    expect(w.find('[data-test=user-toggle]').exists()).toBe(true);
    expect(w.findAll('[data-test=user-self]')).toHaveLength(1);
  });
});
