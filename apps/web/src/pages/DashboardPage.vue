<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { Building } from '@/api/types';
import { useAuthStore } from '@/stores/auth';

const { t } = useI18n();
const auth = useAuthStore();
const buildings = ref<Building[]>([]);
const contactsTotal = ref(0);
onMounted(async () => {
  const [b, c] = await Promise.all([api.get<{ rows: Building[] }>('/api/buildings'), api.get<{ total: number }>('/api/contacts', { pageSize: 1 })]);
  buildings.value = b.rows; contactsTotal.value = c.total;
});
</script>
<template>
  <h1 class="mb-4 text-2xl font-semibold">{{ t('dashboard.welcome', { name: auth.user?.firstName ?? '' }) }}</h1>
  <div class="grid grid-cols-3 gap-4">
    <div class="rounded-xl bg-white p-4 shadow-sm"><div class="text-sm text-slate-500">{{ t('dashboard.buildings') }}</div><div class="text-3xl font-semibold" data-test="stat-buildings">{{ buildings.length }}</div></div>
    <div class="rounded-xl bg-white p-4 shadow-sm"><div class="text-sm text-slate-500">{{ t('dashboard.units') }}</div><div class="text-3xl font-semibold">{{ buildings.reduce((s, b) => s + (b.unitCount ?? 0), 0) }}</div></div>
    <div class="rounded-xl bg-white p-4 shadow-sm"><div class="text-sm text-slate-500">{{ t('dashboard.contacts') }}</div><div class="text-3xl font-semibold">{{ contactsTotal }}</div></div>
  </div>
</template>
