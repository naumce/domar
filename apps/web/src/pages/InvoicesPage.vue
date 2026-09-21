<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { Building, InvoiceRow, InvoiceStatus } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import { useResource } from '@/composables/useResource';
import { formatMoney } from '@/utils/money';

const { t } = useI18n();
const res = useResource<InvoiceRow>('/api/invoices');
const buildings = ref<Building[]>([]);
const f = ref({ buildingId: null as string | null, period: '', status: null as InvoiceStatus | null });
const statuses: InvoiceStatus[] = ['draft', 'published', 'partially_paid', 'paid', 'cancelled'];
function search() { void res.load({ buildingId: f.value.buildingId ?? undefined, period: f.value.period || undefined, status: f.value.status ?? undefined, pageSize: 200 }); }
onMounted(async () => { search(); buildings.value = (await api.get<{ rows: Building[] }>('/api/buildings')).rows; });
</script>
<template>
  <h1 class="mb-4 text-2xl font-semibold">{{ t('invoices.title') }} <span class="text-base text-slate-500">{{ res.total.value }}</span></h1>
  <form class="mb-3 grid grid-cols-4 items-end gap-3" @submit.prevent="search">
    <AppSelect v-model="f.buildingId" :label="t('invoices.building')" :options="[{ value: null, label: t('buildings.none') }, ...buildings.map((b) => ({ value: b.id, label: b.name }))]" />
    <AppInput v-model="f.period" :label="t('billing.period')" type="month" />
    <AppSelect v-model="f.status" :label="t('billing.status')" :options="[{ value: null, label: '—' }, ...statuses.map((s) => ({ value: s, label: t(`invoices.status.${s}`) }))]" />
    <AppButton type="submit" variant="secondary">{{ t('app.search') }}</AppButton>
  </form>
  <p v-if="res.error.value" class="mb-2 text-sm text-red-600" data-test="page-error">{{ t('app.error') }}</p>
  <DataTable :columns="[{ key: 'number', label: t('invoices.number') }, { key: 'period', label: t('billing.period') }, { key: 'building', label: t('invoices.building') }, { key: 'contact', label: t('invoices.owner') }, { key: 'amountDueMinor', label: t('billing.amountDue') }, { key: 'dueAt', label: t('invoices.due') }, { key: 'status', label: t('billing.status') }]" :rows="res.rows.value">
    <template #cell-number="{ row }"><RouterLink :to="`/app/invoices/${row.id}`" class="text-emerald-700 underline" data-test="invoice-link">{{ row.number ?? t('invoices.status.draft') }}</RouterLink></template>
    <template #cell-building="{ row }">{{ row.building.name }}</template>
    <template #cell-contact="{ row }">{{ row.contact.firstName }} {{ row.contact.lastName }}</template>
    <template #cell-amountDueMinor="{ row }">{{ formatMoney(row.amountDueMinor) }}</template>
    <template #cell-dueAt="{ row }">{{ row.dueAt ? new Date(row.dueAt).toLocaleDateString('mk-MK') : '—' }}</template>
    <template #cell-status="{ row }">{{ t(`invoices.status.${row.status}`) }}</template>
  </DataTable>
</template>
