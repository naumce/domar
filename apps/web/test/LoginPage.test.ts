import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, expect, it, vi } from 'vitest';
import { createRouter, createMemoryHistory } from 'vue-router';
import { i18n, messages } from '@/i18n';
import LoginPage from '@/pages/LoginPage.vue';
import { useAuthStore } from '@/stores/auth';

function flatKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) => (typeof v === 'object' && v !== null ? flatKeys(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`]));
}

describe('i18n', () => {
  it('mk and en define the same keys', () => {
    expect(flatKeys(messages.en).sort()).toEqual(flatKeys(messages.mk).sort());
  });
});

describe('LoginPage', () => {
  it('submits tenant slug, email and password and navigates to /app', async () => {
    setActivePinia(createPinia());
    const store = useAuthStore();
    const loginSpy = vi.spyOn(store, 'login').mockResolvedValue();
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div/>' } }, { path: '/app', component: { template: '<div/>' } }] });
    const wrapper = mount(LoginPage, { global: { plugins: [i18n, router] } });
    await wrapper.get('[data-test=tenantSlug]').setValue('firma');
    await wrapper.get('[data-test=email]').setValue('a@b.mk');
    await wrapper.get('[data-test=password]').setValue('correct-horse-1');
    await wrapper.get('form').trigger('submit');
    await new Promise((r) => setTimeout(r, 0));
    expect(loginSpy).toHaveBeenCalledWith({ tenantSlug: 'firma', email: 'a@b.mk', password: 'correct-horse-1' });
    await router.isReady();
    expect(router.currentRoute.value.path).toBe('/app');
  });

  it('shows the API error message', async () => {
    setActivePinia(createPinia());
    const store = useAuthStore();
    vi.spyOn(store, 'login').mockRejectedValue(Object.assign(new Error('Invalid organization, email or password'), { code: 'invalid_credentials' }));
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div/>' } }] });
    const wrapper = mount(LoginPage, { global: { plugins: [i18n, router] } });
    await wrapper.get('form').trigger('submit');
    await new Promise((r) => setTimeout(r, 0));
    expect(wrapper.text()).toContain(i18n.global.t('auth.errors.invalid_credentials'));
  });
});
