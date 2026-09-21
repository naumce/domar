<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { i18n, setLocale, type Locale } from '@/i18n';
import { useAuthStore } from '@/stores/auth';

const { t } = useI18n();
const auth = useAuthStore();
const router = useRouter();
const nav = [
  { to: '/app', key: 'nav.dashboard' }, { to: '/app/buildings', key: 'nav.buildings' }, { to: '/app/contacts', key: 'nav.contacts' }, { to: '/app/tax-rates', key: 'nav.taxRates' },
];
async function logout() { await auth.logout(); await router.push('/login'); }
function toggleLocale() { setLocale((i18n.global.locale.value === 'mk' ? 'en' : 'mk') as Locale); }
</script>
<template>
  <div class="flex min-h-screen">
    <aside class="w-60 shrink-0 border-r border-slate-200 bg-white p-4">
      <div class="mb-6 text-lg font-bold text-emerald-700">domar</div>
      <nav class="space-y-1">
        <RouterLink v-for="n in nav" :key="n.to" :to="n.to" class="block rounded-md px-3 py-2 text-sm hover:bg-slate-100" active-class="bg-emerald-50 text-emerald-800 font-medium" :data-test="`nav-${n.key.split('.')[1]}`">{{ t(n.key) }}</RouterLink>
      </nav>
      <div class="mt-8 border-t border-slate-200 pt-4 text-sm">
        <div class="font-medium">{{ auth.user?.firstName }} {{ auth.user?.lastName }}</div>
        <div class="text-slate-500">{{ auth.tenant?.name }}</div>
        <button class="mt-2 text-slate-600 underline" @click="toggleLocale">{{ i18n.global.locale.value.toUpperCase() }}</button>
        <button class="ml-3 mt-2 text-slate-600 underline" data-test="logout" @click="logout">{{ t('nav.logout') }}</button>
      </div>
    </aside>
    <main class="flex-1 p-6"><RouterView /></main>
  </div>
</template>
