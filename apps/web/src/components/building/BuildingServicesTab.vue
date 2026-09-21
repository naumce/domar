<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { BuildingService, Service } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import ModalDialog from '@/components/ModalDialog.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import { swallow, useResource } from '@/composables/useResource';
import { formatMoney, percentFromBp, toMinor } from '@/utils/money';

const props = defineProps<{ buildingId: string }>();
const { t } = useI18n();
const res = useResource<BuildingService>(`/api/buildings/${props.buildingId}/services`);
const catalog = ref<Service[]>([]);
const open = ref(false);
const now = new Date();
const form = ref({ serviceId: null as string | null, startsPeriod: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`, frequency: 'monthly' as 'monthly' | 'every_n_months', intervalMonths: '3', price: '' });
const error = ref('');
onMounted(async () => { await res.load(); catalog.value = (await api.get<{ rows: Service[] }>('/api/services', { recurring: 'true' })).rows; });
async function submit() {
  error.value = '';
  const raw = form.value.price.trim();
  const price = raw === '' ? null : toMinor(raw);
  if (!form.value.serviceId || (raw !== '' && price === null)) { error.value = t('auth.errors.validation'); return; }
  let intervalMonths = 1;
  if (form.value.frequency === 'every_n_months') {
    intervalMonths = Number(form.value.intervalMonths);
    if (!Number.isInteger(intervalMonths) || intervalMonths < 2) { error.value = t('auth.errors.validation'); return; }
  }
  try {
    await res.create({ serviceId: form.value.serviceId, startsPeriod: form.value.startsPeriod, frequency: form.value.frequency, intervalMonths, priceMinor: price });
    open.value = false;
  } catch (e) {
    const code = (e as { code?: string }).code;
    error.value = code === 'already_attached' ? t('buildingServices.alreadyAttached') : code === 'validation' || code === 'invalid_reference' ? t('auth.errors.validation') : t('app.error');
  }
}
</script>
<template>
  <div class="mb-3 flex items-center justify-between"><h2 class="text-lg font-semibold">{{ t('buildingServices.title') }}</h2><AppButton data-test="attach-service" @click="open = true">{{ t('buildingServices.attach') }}</AppButton></div>
  <p v-if="res.error.value" class="mb-2 text-sm text-red-600" data-test="page-error">{{ t('app.error') }}</p>
  <DataTable :columns="[{ key: 'service', label: t('services.name') }, { key: 'effectivePricing', label: t('services.pricing') }, { key: 'effectivePriceMinor', label: t('billing.unitPrice') }, { key: 'frequency', label: t('buildingServices.frequency') }, { key: 'startsPeriod', label: t('buildingServices.startsPeriod') }]" :rows="res.rows.value">
    <template #cell-service="{ row }">{{ row.service.name }} <span class="text-slate-500">({{ percentFromBp(row.service.taxRateBp) }})</span></template>
    <template #cell-effectivePricing="{ row }">{{ t(`services.pricingOptions.${row.effectivePricing}`) }}</template>
    <template #cell-effectivePriceMinor="{ row }">{{ formatMoney(row.effectivePriceMinor) }}</template>
    <template #cell-frequency="{ row }">{{ row.frequency === 'monthly' ? t('buildingServices.monthly') : `${t('buildingServices.everyN')}: ${row.intervalMonths}` }}</template>
    <template #actions="{ row }"><AppButton variant="danger" @click="swallow(res.remove(row.id))">{{ t('buildingServices.detach') }}</AppButton></template>
  </DataTable>
  <ModalDialog :open="open" :title="t('buildingServices.attach')" @close="open = false">
    <form class="grid grid-cols-2 gap-3" @submit.prevent="submit">
      <AppSelect v-model="form.serviceId" :label="t('services.name')" :options="[{ value: null, label: '—' }, ...catalog.map((s) => ({ value: s.id, label: `${s.name} · ${formatMoney(s.defaultPriceMinor)}` }))]" data-test="attach-service-select" class="col-span-2" />
      <AppInput v-model="form.startsPeriod" :label="t('buildingServices.startsPeriod')" type="month" data-test="attach-starts" />
      <AppSelect v-model="form.frequency" :label="t('buildingServices.frequency')" :options="[{ value: 'monthly', label: t('buildingServices.monthly') }, { value: 'every_n_months', label: t('buildingServices.everyN') }]" />
      <AppInput v-if="form.frequency === 'every_n_months'" v-model="form.intervalMonths" :label="t('buildingServices.intervalMonths')" type="number" />
      <AppInput v-model="form.price" :label="t('buildingServices.overridePrice')" placeholder="—" data-test="attach-price" />
      <p v-if="error" class="col-span-2 text-sm text-red-600" data-test="error">{{ error }}</p>
      <div class="col-span-2 flex justify-end gap-2"><AppButton variant="secondary" @click="open = false">{{ t('app.cancel') }}</AppButton><AppButton type="submit" data-test="attach-submit">{{ t('app.save') }}</AppButton></div>
    </form>
  </ModalDialog>
</template>
