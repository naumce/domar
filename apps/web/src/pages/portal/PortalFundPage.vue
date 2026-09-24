<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { PortalFund } from '@/api/types';
import { usePortalStore } from '@/stores/portal';
import { formatMoney } from '@/utils/money';

const { t } = useI18n();
const portal = usePortalStore();
const buildingId = ref<string | null>(null);
const fund = ref<PortalFund | null>(null);
const error = ref('');

async function load() {
  const contactId = portal.selectedContactId;
  const id = buildingId.value ?? portal.current?.buildings[0]?.id ?? null;
  buildingId.value = id;
  if (!contactId || !id) { fund.value = null; return; }
  error.value = '';
  try { fund.value = await api.get<PortalFund>(`/api/portal/buildings/${id}/fund`, { contactId }); }
  catch { error.value = t('app.error'); }
}
onMounted(() => { void nextTick(load); });
watch(() => portal.selectedContactId, () => { buildingId.value = null; void load(); });
watch(buildingId, (v, old) => { if (v && old && v !== old) void load(); });
const date = (d: string) => new Date(d).toLocaleDateString('mk-MK');
</script>
<template>
  <h1 class="mb-1 text-2xl font-semibold">{{ t('portal.fund') }}</h1>
  <p class="mb-4 text-sm text-slate-600">{{ t('portal.fundNote') }}</p>
  <p v-if="error" class="mb-2 text-sm text-red-600" data-test="portal-page-error">{{ error }}</p>
  <select v-if="(portal.current?.buildings.length ?? 0) > 1" v-model="buildingId" class="mb-4 rounded-md border border-slate-300 px-2 py-1 text-sm" data-test="portal-fund-building">
    <option v-for="b in portal.current!.buildings" :key="b.id" :value="b.id">{{ b.name }}</option>
  </select>
  <div v-if="fund">
    <h2 class="mb-2 text-lg font-medium">{{ fund.building.name }}</h2>
    <div class="grid gap-4 sm:grid-cols-2">
      <div class="rounded-xl bg-white p-4 shadow-sm">
        <div class="text-sm text-slate-500">{{ t('portal.fundRegular') }} — {{ t('portal.fundBalance') }}</div>
        <div class="text-xl font-semibold" data-test="portal-fund-regular">{{ formatMoney(fund.regular.balanceMinor) }}</div>
        <div class="mt-2 text-sm text-slate-500">{{ t('portal.fundBilled') }}</div>
        <div data-test="portal-fund-billed-regular">{{ formatMoney(fund.regular.billedMinor) }}</div>
      </div>
      <div class="rounded-xl bg-white p-4 shadow-sm">
        <div class="text-sm text-slate-500">{{ t('portal.fundReserve') }} — {{ t('portal.fundBalance') }}</div>
        <div class="text-xl font-semibold" data-test="portal-fund-reserve">{{ formatMoney(fund.reserve.balanceMinor) }}</div>
        <div class="mt-2 text-sm text-slate-500">{{ t('portal.fundBilled') }}</div>
        <div data-test="portal-fund-billed-reserve">{{ formatMoney(fund.reserve.billedMinor) }}</div>
      </div>
    </div>
    <h2 class="mb-2 mt-6 text-lg font-semibold">{{ t('portal.fundTransactions') }}</h2>
    <div class="overflow-x-auto rounded-xl bg-white shadow-sm">
      <table class="w-full text-sm">
        <thead class="bg-slate-50 text-left text-slate-600"><tr><th class="px-4 py-2 font-medium">{{ t('portal.date') }}</th><th class="px-4 py-2 font-medium">{{ t('billing.fund') }}</th><th class="px-4 py-2 font-medium">{{ t('portal.status') }}</th><th class="px-4 py-2 font-medium">{{ t('portal.description') }}</th><th class="px-4 py-2 text-right font-medium">{{ t('portal.amount') }}</th></tr></thead>
        <tbody>
          <tr v-if="fund.transactions.length === 0"><td colspan="5" class="px-4 py-6 text-center text-slate-500">{{ t('app.empty') }}</td></tr>
          <tr v-for="tx in fund.transactions" :key="tx.id" class="border-t border-slate-100" data-test="portal-fund-tx">
            <td class="px-4 py-2">{{ date(tx.bookedAt) }}</td>
            <td class="px-4 py-2">{{ t(`billing.${tx.fund}`) }}</td>
            <td class="px-4 py-2">{{ t(`ledger.kind.${tx.kind}`) }}</td>
            <td class="px-4 py-2">{{ tx.description ?? '—' }}</td>
            <td class="px-4 py-2 text-right">{{ formatMoney(tx.amountMinor) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
