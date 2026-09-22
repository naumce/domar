<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { Building, Payment, PaymentMethod, PaymentSummary } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import { formatMoney } from '@/utils/money';

const { t } = useI18n();
const rows = ref<Payment[]>([]); const total = ref(0); const summary = ref<PaymentSummary | null>(null); const buildings = ref<Building[]>([]); const error = ref('');
const f = ref({ buildingId: null as string | null, method: null as PaymentMethod | null, status: null as 'completed' | 'voided' | null, from: '', to: '', search: '' });
const methods: PaymentMethod[] = ['bank_transfer', 'cash', 'card', 'cheque', 'other'];
/** The API's `to` is exclusive, so the last day of the range is included by asking for next-day local midnight. */
function endOfDayIso(day: string) { const d = new Date(`${day}T00:00:00`); d.setDate(d.getDate() + 1); return d.toISOString(); }
async function search() {
  error.value = '';
  try {
    const r = await api.get<{ rows: Payment[]; total: number; summary: PaymentSummary }>('/api/payments', {
      buildingId: f.value.buildingId ?? undefined, method: f.value.method ?? undefined, status: f.value.status ?? undefined,
      from: f.value.from ? new Date(`${f.value.from}T00:00:00`).toISOString() : undefined, to: f.value.to ? endOfDayIso(f.value.to) : undefined,
      search: f.value.search || undefined, pageSize: 200,
    });
    rows.value = r.rows; total.value = r.total; summary.value = r.summary;
  } catch { error.value = t('app.error'); }
}
onMounted(async () => { await search(); buildings.value = (await api.get<{ rows: Building[] }>('/api/buildings')).rows; });
async function voidPayment(id: string) { const reason = window.prompt(t('payments.voidReason')); if (!reason) return; try { await api.post(`/api/payments/${id}/void`, { reason }); await search(); } catch { error.value = t('app.error'); } }
</script>
<template>
  <h1 class="mb-4 text-2xl font-semibold">{{ t('payments.title') }} <span class="text-base text-slate-500">{{ total }}</span></h1>
  <div v-if="summary" class="mb-4 grid grid-cols-3 gap-4">
    <div class="rounded-xl bg-white p-4 shadow-sm"><div class="text-sm text-slate-500">{{ t('payments.received') }}</div><div class="text-2xl font-semibold" data-test="sum-received">{{ formatMoney(summary.totalMinor) }}</div></div>
    <div class="rounded-xl bg-white p-4 shadow-sm"><div class="text-sm text-slate-500">{{ t('payments.count') }}</div><div class="text-2xl font-semibold">{{ summary.completedCount }}</div></div>
    <div class="rounded-xl bg-white p-4 shadow-sm"><div class="text-sm text-slate-500">{{ t('payments.voidedCount') }}</div><div class="text-2xl font-semibold">{{ summary.voidedCount }}</div></div>
  </div>
  <form class="mb-3 grid grid-cols-6 items-end gap-3" @submit.prevent="search">
    <AppSelect v-model="f.buildingId" :label="t('invoices.building')" :options="[{ value: null, label: t('buildings.none') }, ...buildings.map((b) => ({ value: b.id, label: b.name }))]" />
    <AppSelect v-model="f.method" :label="t('payments.method')" :options="[{ value: null, label: '—' }, ...methods.map((m) => ({ value: m, label: t(`payments.methods.${m}`) }))]" />
    <AppSelect v-model="f.status" :label="t('billing.status')" :options="[{ value: null, label: '—' }, { value: 'completed', label: t('payments.status.completed') }, { value: 'voided', label: t('payments.status.voided') }]" />
    <AppInput v-model="f.from" :label="t('payments.from')" type="date" /><AppInput v-model="f.to" :label="t('payments.to')" type="date" />
    <div class="flex items-end gap-2"><AppInput v-model="f.search" :label="t('app.search')" data-test="pay-search" /><AppButton type="submit" variant="secondary">{{ t('app.search') }}</AppButton></div>
  </form>
  <p v-if="error" class="mb-2 text-sm text-red-600" data-test="page-error">{{ error }}</p>
  <DataTable :columns="[{ key: 'paidAt', label: t('payments.paidAt') }, { key: 'building', label: t('invoices.building') }, { key: 'contact', label: t('invoices.owner') }, { key: 'invoice', label: t('invoices.number') }, { key: 'method', label: t('payments.method') }, { key: 'amountMinor', label: t('payments.amount') }, { key: 'status', label: t('billing.status') }]" :rows="rows">
    <template #cell-paidAt="{ row }">{{ new Date(row.paidAt).toLocaleDateString('mk-MK') }}</template>
    <template #cell-building="{ row }">{{ row.building.name }}</template>
    <template #cell-contact="{ row }">{{ row.contact.firstName }} {{ row.contact.lastName }}</template>
    <template #cell-invoice="{ row }"><RouterLink v-if="row.invoice" :to="`/app/invoices/${row.invoice.id}`" class="text-emerald-700 underline" data-test="invoice-link">{{ row.invoice.number ?? t('invoices.status.draft') }}</RouterLink><span v-else class="text-slate-500">{{ t('payments.onAccount') }}</span></template>
    <template #cell-method="{ row }">{{ t(`payments.methods.${row.method}`) }}</template>
    <template #cell-amountMinor="{ row }"><span :class="{ 'line-through text-slate-400': row.status === 'voided' }">{{ formatMoney(row.amountMinor) }}</span></template>
    <template #cell-status="{ row }">{{ t(`payments.status.${row.status}`) }}</template>
    <template #actions="{ row }"><AppButton v-if="row.status === 'completed'" variant="danger" data-test="void-payment" @click="voidPayment(row.id)">{{ t('payments.void') }}</AppButton></template>
  </DataTable>
</template>
