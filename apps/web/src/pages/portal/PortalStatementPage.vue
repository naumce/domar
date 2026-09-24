<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { OwnerStatement } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import { usePortalStore } from '@/stores/portal';
import { formatMoney } from '@/utils/money';

const { t } = useI18n();
const portal = usePortalStore();
const statement = ref<OwnerStatement | null>(null);
const error = ref('');

async function load() {
  const contactId = portal.selectedContactId;
  if (!contactId) { statement.value = null; return; }
  error.value = '';
  try { statement.value = await api.get<OwnerStatement>('/api/portal/statement', { contactId }); }
  catch { error.value = t('app.error'); }
}
onMounted(() => { void nextTick(load); });
watch(() => portal.selectedContactId, load);
</script>
<template>
  <h1 class="mb-4 text-2xl font-semibold">{{ t('portal.statement') }}</h1>
  <p v-if="error" class="mb-2 text-sm text-red-600" data-test="portal-page-error">{{ error }}</p>
  <DataTable v-if="statement" :columns="[{ key: 'bookedAt', label: t('portal.date') }, { key: 'label', label: t('portal.description') }, { key: 'kind', label: t('portal.status') }, { key: 'fund', label: t('billing.fund') }, { key: 'amountMinor', label: t('portal.amount') }, { key: 'balanceMinor', label: t('portal.balance') }]" :rows="statement.rows">
    <template #cell-bookedAt="{ row }">{{ new Date(row.bookedAt).toLocaleDateString('mk-MK') }}</template>
    <template #cell-kind="{ row }">{{ t(`ledger.kind.${row.kind}`) }}</template>
    <template #cell-fund="{ row }">{{ t(`billing.${row.fund}`) }}</template>
    <template #cell-amountMinor="{ row }">{{ formatMoney(row.amountMinor) }}</template>
    <template #cell-balanceMinor="{ row }">{{ formatMoney(row.balanceMinor) }}</template>
  </DataTable>
  <p v-if="statement" class="mt-4 text-right text-lg font-semibold">{{ t('portal.balance') }}: <span data-test="portal-statement-balance">{{ formatMoney(statement.balanceMinor) }}</span></p>
</template>
