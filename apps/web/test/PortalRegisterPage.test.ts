import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { i18n } from '@/i18n';
import PortalRegisterPage from '@/pages/portal/PortalRegisterPage.vue';
import { usePortalStore } from '@/stores/portal';

const routes = [
  { path: '/', component: { template: '<div/>' } },
  { path: '/portal', component: { template: '<div/>' } },
  { path: '/portal/login', component: { template: '<div/>' } },
];

describe('PortalRegisterPage', () => {
  it('posts the code, email and password and lands on the portal home', async () => {
    setActivePinia(createPinia());
    const store = usePortalStore();
    const spy = vi.spyOn(store, 'register').mockResolvedValue();
    const router = createRouter({ history: createMemoryHistory(), routes });
    const w = mount(PortalRegisterPage, { global: { plugins: [i18n, router] } });
    await w.get('[data-test=portal-code]').setValue('Ab3kM9xQ');
    await w.get('[data-test=portal-email]').setValue('marko@owner.mk');
    await w.get('[data-test=portal-password]').setValue('correct-horse-1');
    await w.get('form').trigger('submit');
    await new Promise((r) => setTimeout(r, 0));
    expect(spy).toHaveBeenCalledWith({ code: 'Ab3kM9xQ', email: 'marko@owner.mk', password: 'correct-horse-1' });
    await router.isReady();
    expect(router.currentRoute.value.path).toBe('/portal');
  });

  it('shows the wording for a wrong code and stays on the page', async () => {
    setActivePinia(createPinia());
    const store = usePortalStore();
    vi.spyOn(store, 'register').mockRejectedValue(Object.assign(new Error('nope'), { code: 'invalid_code' }));
    const router = createRouter({ history: createMemoryHistory(), routes });
    const w = mount(PortalRegisterPage, { global: { plugins: [i18n, router] } });
    await w.get('[data-test=portal-code]').setValue('ZZZZZZZZ');
    await w.get('form').trigger('submit');
    await new Promise((r) => setTimeout(r, 0));
    expect(w.get('[data-test=portal-error]').text()).toBe('Кодот е погрешен, искористен или истечен.');
    expect(router.currentRoute.value.path).toBe('/');
  });

  it('shows the wording for an email that already has an account', async () => {
    setActivePinia(createPinia());
    const store = usePortalStore();
    vi.spyOn(store, 'register').mockRejectedValue(Object.assign(new Error('nope'), { code: 'email_taken' }));
    const router = createRouter({ history: createMemoryHistory(), routes });
    const w = mount(PortalRegisterPage, { global: { plugins: [i18n, router] } });
    await w.get('form').trigger('submit');
    await new Promise((r) => setTimeout(r, 0));
    expect(w.get('[data-test=portal-error]').text()).toContain('Најавете се и додадете го кодот во Поставки.');
  });
});

describe('portal store', () => {
  it('keeps the selected contact inside the links it was given', async () => {
    setActivePinia(createPinia());
    const store = usePortalStore();
    const me = {
      account: { id: 'a1', email: 'marko@owner.mk' },
      links: [
        { tenantId: 't1', tenantName: 'Фирма 1', contactId: 'c1', contactName: 'Марко Марков', buildings: [{ id: 'b1', name: 'Партизанска 12' }] },
        { tenantId: 't2', tenantName: 'Фирма 2', contactId: 'c2', contactName: 'Марко Марков', buildings: [] },
      ],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(me), { status: 200, headers: { 'content-type': 'application/json' } })));
    await store.fetchMe();
    expect(store.ready).toBe(true);
    expect(store.selectedContactId).toBe('c1');
    expect(store.current?.tenantName).toBe('Фирма 1');
    store.select('c2');
    expect(store.current?.tenantName).toBe('Фирма 2');
    expect(localStorage.getItem('domar.portal.contactId')).toBe('c2');
    vi.unstubAllGlobals();
  });
});
