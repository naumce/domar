<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { InvoiceRow } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import { usePortalStore } from '@/stores/portal';
import { formatMoney } from '@/utils/money';

const { t } = useI18n();
const portal = usePortalStore();
const rows = ref<InvoiceRow[]>([]);
const error = ref('');

async function load() {
  const contactId = portal.selectedContactId;
  if (!contactId) { rows.value = []; return; }
  error.value = '';
  try { rows.value = (await api.get<{ rows: InvoiceRow[]; total: number }>('/api/portal/invoices', { contactId, page: 1, pageSize: 50 })).rows; }
  catch { error.value = t('app.error'); }
}
onMounted(load);
watch(() => portal.selectedContactId, load);
const date = (d: string | null) => (d ? new Date(d).toLocaleDateString('mk-MK') : '—');
</script>
<template>
  <h1 class="mb-4 text-2xl font-semibold">{{ t('portal.invoices') }}</h1>
  <p v-if="error" class="mb-2 text-sm text-red-600" data-test="portal-page-error">{{ error }}</p>
  <DataTable :columns="[{ key: 'period', label: t('portal.period') }, { key: 'number', label: t('portal.number') }, { key: 'dueAt', label: t('invoices.due') }, { key: 'totalMinor', label: t('portal.total') }, { key: 'outstandingMinor', label: t('portal.outstanding') }, { key: 'status', label: t('portal.status') }]" :rows="rows">
    <template #cell-number="{ row }">
      <RouterLink :to="`/portal/invoices/${row.id}`" class="text-emerald-700 underline" data-test="portal-invoice-link">{{ row.number ?? row.id }}</RouterLink>
    </template>
    <template #cell-dueAt="{ row }">{{ date(row.dueAt) }}</template>
    <template #cell-totalMinor="{ row }"><span data-test="portal-invoice-total">{{ formatMoney(row.totalMinor) }}</span></template>
    <template #cell-outstandingMinor="{ row }"><span data-test="portal-invoice-outstanding">{{ formatMoney(row.outstandingMinor) }}</span></template>
    <template #cell-status="{ row }">{{ t(`invoices.status.${row.status}`) }}</template>
  </DataTable>
</template>
