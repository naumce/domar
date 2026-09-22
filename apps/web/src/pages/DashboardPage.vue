<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { DashboardStats } from '@/api/types';
import { useAuthStore } from '@/stores/auth';
import { formatMoney } from '@/utils/money';

const { t } = useI18n();
const auth = useAuthStore();
const stats = ref<DashboardStats | null>(null);
onMounted(async () => { stats.value = await api.get<DashboardStats>('/api/dashboard/stats'); });
</script>
<template>
  <h1 class="mb-4 text-2xl font-semibold">{{ t('dashboard.welcome', { name: auth.user?.firstName ?? '' }) }}</h1>
  <div v-if="stats" class="grid grid-cols-4 gap-4">
    <div class="rounded-xl bg-white p-4 shadow-sm"><div class="text-sm text-slate-500">{{ t('dashboard.buildings') }}</div><div class="text-3xl font-semibold" data-test="stat-buildings">{{ stats.totalProperties }}</div></div>
    <div class="rounded-xl bg-white p-4 shadow-sm"><div class="text-sm text-slate-500">{{ t('dashboard.units') }}</div><div class="text-3xl font-semibold" data-test="stat-units">{{ stats.totalUnits }}</div></div>
    <div class="rounded-xl bg-white p-4 shadow-sm"><div class="text-sm text-slate-500">{{ t('dashboard.owners') }}</div><div class="text-3xl font-semibold" data-test="stat-owners">{{ stats.assignedOwners }}</div></div>
    <div class="rounded-xl bg-white p-4 shadow-sm"><div class="text-sm text-slate-500">{{ t('dashboard.billed') }}</div><div class="text-3xl font-semibold" data-test="stat-billed">{{ formatMoney(stats.billedThisMonthMinor) }}</div></div>
    <div class="rounded-xl bg-white p-4 shadow-sm"><div class="text-sm text-slate-500">{{ t('dashboard.paid') }}</div><div class="text-3xl font-semibold" data-test="stat-paid">{{ formatMoney(stats.paidThisMonthMinor) }}</div></div>
    <div class="rounded-xl bg-white p-4 shadow-sm"><div class="text-sm text-slate-500">{{ t('dashboard.unpaid') }}</div><div class="text-3xl font-semibold" data-test="stat-unpaid">{{ stats.unpaidInvoices }}</div></div>
    <div class="rounded-xl bg-white p-4 shadow-sm"><div class="text-sm text-slate-500">{{ t('dashboard.outstanding') }}</div><div class="text-3xl font-semibold" data-test="stat-outstanding">{{ formatMoney(stats.outstandingMinor) }}</div></div>
  </div>
</template>
