import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '@/api/client';
import type { Tenant, User } from '@/api/types';

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null);
  const tenant = ref<Tenant | null>(null);
  const ready = ref(false);

  async function fetchMe() {
    try {
      const me = await api.get<{ user: User; tenant: Tenant }>('/api/auth/me');
      user.value = me.user; tenant.value = me.tenant;
    } catch {
      user.value = null; tenant.value = null;
    } finally {
      ready.value = true;
    }
  }
  async function login(payload: { tenantSlug: string; email: string; password: string }) {
    const me = await api.post<{ user: User; tenant: Tenant }>('/api/auth/login', payload);
    user.value = me.user; tenant.value = me.tenant; ready.value = true;
  }
  async function register(payload: { tenant: { slug: string; name: string; countryCode: 'mk' }; user: { email: string; password: string; firstName: string; lastName: string } }) {
    const me = await api.post<{ user: User; tenant: Tenant }>('/api/auth/register', payload);
    user.value = me.user; tenant.value = me.tenant; ready.value = true;
  }
  async function logout() {
    await api.post('/api/auth/logout');
    user.value = null; tenant.value = null;
  }
  return { user, tenant, ready, fetchMe, login, register, logout };
});
