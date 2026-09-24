<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { Period, TaxRate } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import { useResource } from '@/composables/useResource';
import { formatMoney, percentFromBp, toMinor } from '@/utils/money';

const props = defineProps<{ buildingId: string }>();
const { t } = useI18n();
const res = useResource<Period>(`/api/buildings/${props.buildingId}/periods`);
const taxRates = ref<TaxRate[]>([]);
const now = new Date();
const month = ref(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
const fee = ref('');
const feeTax = ref<string | null>(null);
const error = ref('');
const ready = ref(false);
onMounted(async () => {
  const [, rates] = await Promise.all([res.load(), api.get<{ rows: TaxRate[] }>('/api/tax-rates')]);
  taxRates.value = rates.rows;
  feeTax.value = taxRates.value.find((r) => r.isDefault)?.id ?? null;
  ready.value = true;
});
async function create() {
  error.value = '';
  const feeMinor = fee.value.trim() === '' ? 0 : toMinor(fee.value);
  if (feeMinor === null) { error.value = t('auth.errors.validation'); return; }
  try { await res.create({ period: month.value, managementFeeMinor: feeMinor, managementFeeTaxRateId: feeTax.value }); fee.value = ''; }
  catch (e) { error.value = (e as { code?: string }).code === 'period_exists' ? t('periods.exists') : t('app.error'); }
}
</script>
<template>
  <form class="mb-4 grid grid-cols-4 items-end gap-3 rounded-xl bg-white p-4 shadow-sm" @submit.prevent="create">
    <AppInput v-model="month" :label="t('billing.period')" type="month" data-test="period-month" />
    <AppInput v-model="fee" :label="t('periods.managementFee')" data-test="period-fee" placeholder="150,00" />
    <AppSelect v-model="feeTax" :label="t('periods.managementFeeTax')" :options="[{ value: null, label: t('services.noTax') }, ...taxRates.map((r) => ({ value: r.id, label: `${r.name} (${percentFromBp(r.rateBp)})` }))]" />
    <AppButton type="submit" :disabled="!ready" data-test="period-create">{{ t('periods.create') }}</AppButton>
    <p v-if="error" class="col-span-4 text-sm text-red-600" data-test="error">{{ error }}</p>
  </form>
  <p v-if="res.error.value" class="mb-2 text-sm text-red-600" data-test="page-error">{{ t('app.error') }}</p>
  <DataTable :columns="[{ key: 'period', label: t('billing.period') }, { key: 'status', label: t('billing.status') }, { key: 'invoiceCount', label: t('periods.invoices') }, { key: 'totalMinor', label: t('billing.total') }]" :rows="res.rows.value">
    <template #cell-period="{ row }"><RouterLink :to="`/app/buildings/${buildingId}/periods/${row.id}`" class="text-emerald-700 underline" data-test="period-link">{{ row.period }}</RouterLink><span v-if="row.kind === 'extraordinary'" class="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800" data-test="period-kind">{{ t('periods.kind.extraordinary') }}</span></template>
    <template #cell-status="{ row }"><span class="rounded-full px-2 py-0.5 text-xs" :class="{ 'bg-slate-100': row.status === 'open', 'bg-amber-100 text-amber-800': row.status === 'generated', 'bg-emerald-100 text-emerald-800': row.status === 'published' }">{{ t(`periods.status.${row.status}`) }}</span></template>
    <template #cell-totalMinor="{ row }">{{ formatMoney(row.totalMinor) }}</template>
  </DataTable>
</template>
