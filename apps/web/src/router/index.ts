import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { usePortalStore } from '@/stores/portal';

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
        { path: 'compliance', component: () => import('@/pages/CompliancePage.vue') },
        { path: 'tax-rates', component: () => import('@/pages/TaxRatesPage.vue') },
        { path: 'contacts', component: () => import('@/pages/ContactsPage.vue') },
        { path: 'contacts/:id', component: () => import('@/pages/ContactStatementPage.vue'), props: true },
        { path: 'buildings', component: () => import('@/pages/BuildingsPage.vue') },
        { path: 'buildings/:id', component: () => import('@/pages/BuildingDetailPage.vue'), props: true },
        { path: 'buildings/:id/periods/:periodId', component: () => import('@/pages/PeriodPage.vue'), props: true },
        { path: 'services', component: () => import('@/pages/ServicesPage.vue') },
        { path: 'suppliers', component: () => import('@/pages/SuppliersPage.vue') },
        { path: 'invoices', component: () => import('@/pages/InvoicesPage.vue') },
        { path: 'invoices/:id', component: () => import('@/pages/InvoicePage.vue'), props: true },
        { path: 'payments', component: () => import('@/pages/PaymentsPage.vue') },
        { path: 'settings', component: () => import('@/pages/SettingsPage.vue') },
      ],
    },
    { path: '/portal/login', component: () => import('@/pages/portal/PortalLoginPage.vue') },
    { path: '/portal/register', component: () => import('@/pages/portal/PortalRegisterPage.vue') },
    {
      path: '/portal', component: () => import('@/layouts/PortalShell.vue'), meta: { portal: true },
      children: [
        { path: '', component: () => import('@/pages/portal/PortalHomePage.vue') },
        { path: 'invoices', component: () => import('@/pages/portal/PortalInvoicesPage.vue') },
        { path: 'invoices/:id', component: () => import('@/pages/portal/PortalInvoicePage.vue'), props: true },
        { path: 'payments', component: () => import('@/pages/portal/PortalPaymentsPage.vue') },
        { path: 'statement', component: () => import('@/pages/portal/PortalStatementPage.vue') },
        { path: 'fund', component: () => import('@/pages/portal/PortalFundPage.vue') },
        { path: 'assemblies', component: () => import('@/pages/portal/PortalAssembliesPage.vue') },
        { path: 'assemblies/:id', component: () => import('@/pages/portal/PortalAssemblyPage.vue'), props: true },
        { path: 'settings', component: () => import('@/pages/portal/PortalSettingsPage.vue') },
      ],
    },
  ],
});

router.beforeEach(async (to) => {
  // Two independent guards: an owner session never satisfies /app, a staff session never satisfies /portal.
  if (to.meta.portal) {
    const portal = usePortalStore();
    if (!portal.ready) await portal.fetchMe();
    return portal.account ? true : { path: '/portal/login' };
  }
  if (!to.meta.auth) return true;
  const auth = useAuthStore();
  if (!auth.ready) await auth.fetchMe();
  return auth.user ? true : { path: '/login' };
});
