<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { PortalPayment } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import { usePortalStore } from '@/stores/portal';
import { formatMoney } from '@/utils/money';

const { t } = useI18n();
const portal = usePortalStore();
const rows = ref<PortalPayment[]>([]);
const error = ref('');

async function load() {
  const contactId = portal.selectedContactId;
  if (!contactId) { rows.value = []; return; }
  error.value = '';
  try { rows.value = (await api.get<{ rows: PortalPayment[]; total: number }>('/api/portal/payments', { contactId, page: 1, pageSize: 50 })).rows; }
  catch { error.value = t('app.error'); }
}
onMounted(load);
watch(() => portal.selectedContactId, load);
const date = (d: string) => new Date(d).toLocaleDateString('mk-MK');
</script>
<template>
  <h1 class="mb-4 text-2xl font-semibold">{{ t('portal.payments') }}</h1>
  <p v-if="error" class="mb-2 text-sm text-red-600" data-test="portal-page-error">{{ error }}</p>
  <DataTable :columns="[{ key: 'paidAt', label: t('portal.date') }, { key: 'method', label: t('payments.method') }, { key: 'amountMinor', label: t('portal.amount') }, { key: 'invoice', label: t('portal.number') }, { key: 'status', label: t('portal.status') }]" :rows="rows">
    <template #cell-paidAt="{ row }">{{ date(row.paidAt) }}</template>
    <template #cell-method="{ row }">{{ t(`payments.methods.${row.method}`) }}</template>
    <template #cell-amountMinor="{ row }"><span data-test="portal-payment-amount">{{ formatMoney(row.amountMinor) }}</span></template>
    <template #cell-invoice="{ row }">{{ row.invoice?.number ?? '—' }}</template>
    <template #cell-status="{ row }">{{ t(`payments.status.${row.status}`) }}</template>
  </DataTable>
</template>
