<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { EmailBulkResult, InvoiceRow, Period, PeriodLine, Service, TaxRate, Unit } from '@/api/types';
import PeriodLineForm, { type LinePayload } from '@/components/billing/PeriodLineForm.vue';
import DataTable from '@/components/DataTable.vue';
import ModalDialog from '@/components/ModalDialog.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import { formatMoney, percentFromBp, toMinor } from '@/utils/money';

const props = defineProps<{ id: string; periodId: string }>();
const { t } = useI18n();
const base = `/api/buildings/${props.id}/periods/${props.periodId}`;
const period = ref<Period | null>(null);
const invoices = ref<InvoiceRow[]>([]);
const units = ref<Unit[]>([]);
const services = ref<Service[]>([]);
const taxRates = ref<TaxRate[]>([]);
const open = ref(false); const editing = ref<PeriodLine | null>(null); const busy = ref(false); const error = ref('');
const editable = computed(() => period.value?.status !== 'published');
async function load() {
  period.value = await api.get<Period>(base);
  invoices.value = (await api.get<{ rows: InvoiceRow[] }>('/api/invoices', { buildingId: props.id, period: period.value.period, pageSize: 200 })).rows;
}
onMounted(async () => {
  await load();
  [units.value, services.value, taxRates.value] = await Promise.all([
    api.get<{ rows: Unit[] }>(`/api/buildings/${props.id}/units`).then((r) => r.rows),
    api.get<{ rows: Service[] }>('/api/services').then((r) => r.rows),
    api.get<{ rows: TaxRate[] }>('/api/tax-rates', { includeInactive: 'true' }).then((r) => r.rows),
  ]);
});
const unitLabel = (unitId: unknown) => units.value.find((u) => u.id === unitId)?.label ?? String(unitId ?? '');
async function run(fn: () => Promise<unknown>) {
  busy.value = true; error.value = '';
  try { await fn(); await load(); } catch (e) { const code = (e as { code?: string }).code; error.value = code === 'period_locked' ? t('periods.locked') : code === 'nothing_to_publish' ? t('periods.nothingToPublish') : t('app.error'); } finally { busy.value = false; }
}
function openNew() { editing.value = null; open.value = true; }
function openEdit(l: PeriodLine) { editing.value = l; open.value = true; }
async function onLine(payload: LinePayload) {
  await run(async () => { if (editing.value) await api.patch(`${base}/lines/${editing.value.id}`, payload); else await api.post(`${base}/lines`, payload); });
  if (!error.value) open.value = false;
}
async function publish() { if (window.confirm(t('periods.publishConfirm'))) await run(() => api.post(`${base}/publish`)); }
const bulk = ref<EmailBulkResult | null>(null);
async function sendAll() {
  busy.value = true; error.value = ''; bulk.value = null;
  try { bulk.value = await api.post<EmailBulkResult>(`${base}/send`); }
  catch { error.value = t('app.error'); } finally { busy.value = false; }
}

const settingsOpen = ref(false);
const settingsPrefix = ref('');
const settingsSuffix = ref('');
const settingsFee = ref('');
const settingsFeeTaxRateId = ref<string | null>(null);
const settingsTaxTouched = ref(false);
const settingsTaxResolved = ref(false);
function openSettings() {
  if (!period.value) return;
  settingsPrefix.value = period.value.numberPrefix;
  settingsSuffix.value = period.value.numberSuffix;
  settingsFee.value = (period.value.managementFeeMinor / 100).toFixed(2).replace('.', ',');
  settingsFeeTaxRateId.value = taxRates.value.find((r) => r.isActive && r.rateBp === period.value!.managementFeeTaxRateBp)?.id ?? null;
  // The period's rate may be inactive or gone: then the select shows "no tax" and we must not save that back.
  settingsTaxResolved.value = settingsFeeTaxRateId.value !== null;
  settingsTaxTouched.value = false;
  settingsOpen.value = true;
}
async function saveSettings() {
  const managementFeeMinor = toMinor(settingsFee.value) ?? 0;
  const tax = settingsTaxTouched.value || settingsTaxResolved.value ? { managementFeeTaxRateId: settingsFeeTaxRateId.value } : {};
  await run(() => api.patch(base, { numberPrefix: settingsPrefix.value, numberSuffix: settingsSuffix.value, managementFeeMinor, ...tax }));
  if (!error.value) settingsOpen.value = false;
}
</script>
<template>
  <div v-if="period">
    <div class="mb-4 flex items-center justify-between">
      <div><RouterLink :to="`/app/buildings/${id}?tab=periods`" class="text-sm text-emerald-700 underline">← {{ t('periods.title') }}</RouterLink>
        <h1 class="text-2xl font-semibold">{{ t('billing.period') }} {{ period.period }} <span class="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-sm" data-test="period-status">{{ t(`periods.status.${period.status}`) }}</span></h1>
        <p class="text-sm text-slate-600">{{ t('periods.managementFee') }}: {{ formatMoney(period.managementFeeMinor) }} ({{ percentFromBp(period.managementFeeTaxRateBp) }}) · {{ t('periods.numbering') }}: {{ period.numberPrefix }}0001{{ period.numberSuffix }}
          <AppButton v-if="editable" variant="secondary" class="ml-2" data-test="edit-period" @click="openSettings">{{ t('periods.editSettings') }}</AppButton></p></div>
      <div class="flex gap-2">
        <AppButton v-if="editable" variant="secondary" :loading="busy" data-test="refresh-lines" @click="run(() => api.post(`${base}/refresh-lines`))">{{ t('periods.refresh') }}</AppButton>
        <AppButton v-if="editable" :loading="busy" data-test="generate" @click="run(() => api.post(`${base}/generate`))">{{ period.status === 'generated' ? t('periods.regenerate') : t('periods.generate') }}</AppButton>
        <AppButton v-if="period.status === 'generated'" variant="secondary" :loading="busy" data-test="delete-drafts" @click="run(() => api.del(`${base}/drafts`))">{{ t('periods.deleteDrafts') }}</AppButton>
        <AppButton v-if="period.status === 'generated'" :loading="busy" data-test="publish" @click="publish">{{ t('periods.publish') }}</AppButton>
        <AppButton v-if="period.status === 'published'" variant="secondary" :loading="busy" data-test="send-period" @click="sendAll">{{ t('emails.sendPeriod') }}</AppButton>
      </div>
    </div>
    <p v-if="bulk" class="mb-2 text-sm text-emerald-700" data-test="send-period-result">{{ t('emails.result', bulk) }}</p>
    <p v-if="error" class="mb-2 text-sm text-red-600" data-test="error">{{ error }}</p>
    <p v-if="!editable" class="mb-2 text-sm text-slate-600">{{ t('periods.locked') }}</p>
    <ul v-if="period.warnings.length" class="mb-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900" data-test="warnings">
      <li v-for="(w, i) in period.warnings" :key="i">{{ t(`periods.warning.${w.code}`, { unit: unitLabel(w.unitId) }) }}</li>
    </ul>
    <div class="mb-2 flex items-center justify-between"><h2 class="text-lg font-semibold">{{ t('periods.lines') }}</h2><AppButton v-if="editable" data-test="add-line" @click="openNew">{{ t('periods.addLine') }}</AppButton></div>
    <DataTable :columns="[{ key: 'description', label: t('billing.description') }, { key: 'pricing', label: t('services.pricing') }, { key: 'quantity', label: t('billing.quantity') }, { key: 'unitPriceMinor', label: t('billing.unitPrice') }, { key: 'taxRateBp', label: t('billing.tax') }, { key: 'fund', label: t('billing.fund') }, { key: 'source', label: '' }]" :rows="period.lines ?? []">
      <template #cell-pricing="{ row }">{{ t(`services.pricingOptions.${row.pricing}`) }}</template>
      <template #cell-unitPriceMinor="{ row }">{{ formatMoney(row.unitPriceMinor) }}</template>
      <template #cell-taxRateBp="{ row }">{{ percentFromBp(row.taxRateBp) }}</template>
      <template #cell-fund="{ row }">{{ t(`billing.${row.fund}`) }}</template>
      <template #cell-source="{ row }"><span class="rounded-full px-2 py-0.5 text-xs" :class="row.source === 'auto' ? 'bg-sky-100 text-sky-800' : 'bg-slate-100'">{{ t(`periods.${row.source}`) }}</span><span v-if="row.note" class="ml-2 text-xs text-slate-500">{{ row.note }}</span></template>
      <template #actions="{ row }"><template v-if="editable"><AppButton variant="secondary" @click="openEdit(row)">{{ t('app.edit') }}</AppButton><AppButton variant="danger" class="ml-2" @click="run(() => api.del(`${base}/lines/${row.id}`))">{{ t('app.delete') }}</AppButton></template></template>
    </DataTable>
    <h2 class="mb-2 mt-6 text-lg font-semibold">{{ t('periods.invoices') }} <span class="text-slate-500">{{ invoices.length }}</span></h2>
    <DataTable :columns="[{ key: 'number', label: t('invoices.number') }, { key: 'contact', label: t('invoices.owner') }, { key: 'totalMinor', label: t('billing.total') }, { key: 'amountDueMinor', label: t('billing.amountDue') }, { key: 'status', label: t('billing.status') }]" :rows="invoices">
      <template #cell-number="{ row }"><RouterLink :to="`/app/invoices/${row.id}`" class="text-emerald-700 underline" data-test="invoice-link">{{ row.number ?? t('invoices.status.draft') }}</RouterLink></template>
      <template #cell-contact="{ row }">{{ row.contact.firstName }} {{ row.contact.lastName }}</template>
      <template #cell-totalMinor="{ row }">{{ formatMoney(row.totalMinor) }}</template>
      <template #cell-amountDueMinor="{ row }">{{ formatMoney(row.amountDueMinor) }}</template>
      <template #cell-status="{ row }">{{ t(`invoices.status.${row.status}`) }}</template>
    </DataTable>
    <ModalDialog :open="open" :title="editing ? t('app.edit') : t('periods.addLine')" @close="open = false">
      <PeriodLineForm :key="editing?.id ?? 'new'" :services="services" :tax-rates="taxRates" :initial="editing ?? undefined" :require-note="editing?.source === 'auto'" @submit="onLine" />
    </ModalDialog>
    <ModalDialog :open="settingsOpen" :title="t('periods.numbering')" @close="settingsOpen = false">
      <form class="grid grid-cols-2 gap-3" @submit.prevent="saveSettings">
        <AppInput v-model="settingsPrefix" :label="t('periods.prefix')" data-test="period-prefix" />
        <AppInput v-model="settingsSuffix" :label="t('periods.suffix')" data-test="period-suffix" />
        <AppInput v-model="settingsFee" :label="t('periods.managementFee')" data-test="period-fee-edit" class="col-span-2" />
        <AppSelect v-model="settingsFeeTaxRateId" :label="t('periods.managementFeeTax')" :options="[{ value: null, label: t('services.noTax') }, ...taxRates.filter((r) => r.isActive).map((r) => ({ value: r.id, label: `${r.name} (${percentFromBp(r.rateBp)})` }))]" data-test="period-fee-tax" class="col-span-2" @update:model-value="settingsTaxTouched = true" />
        <div class="col-span-2 flex justify-end gap-2">
          <AppButton type="button" variant="secondary" @click="settingsOpen = false">{{ t('app.cancel') }}</AppButton>
          <AppButton type="submit" :loading="busy">{{ t('app.save') }}</AppButton>
        </div>
      </form>
    </ModalDialog>
  </div>
  <p v-else>{{ t('app.loading') }}</p>
</template>
