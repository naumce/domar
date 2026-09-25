<script setup lang="ts">
import { onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import NotificationBell from '@/components/layout/NotificationBell.vue';
import { i18n, setLocale, type Locale } from '@/i18n';
import { registerPortalWorker } from '@/portal/push';
import { usePortalStore } from '@/stores/portal';

const { t } = useI18n();
const router = useRouter();
const portal = usePortalStore();

onMounted(() => { void registerPortalWorker(); });
// No manager nav: an owner never sees buildings, services, users or tax rates (spec §19.5).
const nav = [
  { to: '/portal', key: 'portal.home', test: 'portal-nav-home' },
  { to: '/portal/invoices', key: 'portal.invoices', test: 'portal-nav-invoices' },
  { to: '/portal/payments', key: 'portal.payments', test: 'portal-nav-payments' },
  { to: '/portal/statement', key: 'portal.statement', test: 'portal-nav-statement' },
  { to: '/portal/fund', key: 'portal.fund', test: 'portal-nav-fund' },
  { to: '/portal/assemblies', key: 'portal.assemblies', test: 'portal-nav-assemblies' },
  { to: '/portal/maintenance', key: 'portal.maintenance', test: 'portal-nav-maintenance' },
  { to: '/portal/settings', key: 'portal.settings', test: 'portal-nav-settings' },
];
async function logout() { await portal.logout(); await router.push('/portal/login'); }
function toggleLocale() { setLocale((i18n.global.locale.value === 'mk' ? 'en' : 'mk') as Locale); }
</script>
<template>
  <div class="min-h-screen bg-slate-50">
    <header class="border-b border-slate-200 bg-white">
      <div class="mx-auto flex max-w-4xl flex-wrap items-center gap-3 px-4 py-3">
        <span class="text-lg font-bold text-emerald-700">domar</span>
        <select v-if="portal.links.length > 1" :value="portal.selectedContactId ?? ''" class="rounded-md border border-slate-300 px-2 py-1 text-sm" data-test="portal-link-switch"
          @change="portal.select(($event.target as HTMLSelectElement).value)">
          <option v-for="l in portal.links" :key="l.contactId" :value="l.contactId">{{ l.tenantName }} — {{ l.contactName }}</option>
        </select>
        <span class="ml-auto text-sm text-slate-600">{{ portal.account?.email }}</span>
        <NotificationBell scope="portal" />
        <button class="text-sm text-slate-600 underline" @click="toggleLocale">{{ i18n.global.locale.value.toUpperCase() }}</button>
        <button class="text-sm text-slate-600 underline" data-test="portal-logout" @click="logout">{{ t('portal.signOut') }}</button>
      </div>
      <nav class="mx-auto flex max-w-4xl gap-1 overflow-x-auto px-4 pb-2">
        <!-- `/portal` is a prefix of every child path, so the home link highlights on exact match only. -->
        <RouterLink v-for="n in nav" :key="n.to" :to="n.to" :data-test="n.test" class="whitespace-nowrap rounded-md px-3 py-1.5 text-sm hover:bg-slate-100"
          :active-class="n.to === '/portal' ? '' : 'bg-emerald-50 font-medium text-emerald-800'"
          exact-active-class="bg-emerald-50 font-medium text-emerald-800">{{ t(n.key) }}</RouterLink>
      </nav>
    </header>
    <main class="mx-auto max-w-4xl p-4"><RouterView /></main>
  </div>
</template>
