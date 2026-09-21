import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/app' },
    { path: '/login', component: () => import('@/pages/LoginPage.vue') },
    { path: '/register', component: () => import('@/pages/RegisterPage.vue') },
    {
      path: '/app', component: () => import('@/layouts/AppShell.vue'), meta: { auth: true },
      children: [
        { path: '', component: () => import('@/pages/DashboardPage.vue') },
        { path: 'tax-rates', component: () => import('@/pages/TaxRatesPage.vue') },
        { path: 'contacts', component: () => import('@/pages/ContactsPage.vue') },
        { path: 'buildings', component: () => import('@/pages/BuildingsPage.vue') },
        { path: 'buildings/:id', component: () => import('@/pages/BuildingDetailPage.vue'), props: true },
      ],
    },
    { path: '/portal', component: () => import('@/pages/portal/PortalHomePage.vue') },
  ],
});

router.beforeEach(async (to) => {
  if (!to.meta.auth) return true;
  const auth = useAuthStore();
  if (!auth.ready) await auth.fetchMe();
  return auth.user ? true : { path: '/login' };
});
