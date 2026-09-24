<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { PricingModel, Service, TaxRate, UnitKind } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import ModalDialog from '@/components/ModalDialog.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import { swallow, useResource } from '@/composables/useResource';
import { formatMoney, percentFromBp, toMinor } from '@/utils/money';

const { t } = useI18n();
const res = useResource<Service>('/api/services');
const taxRates = ref<TaxRate[]>([]);
const open = ref(false);
const kinds: UnitKind[] = ['apartment', 'commercial', 'parking', 'storage', 'other'];
const pricings: PricingModel[] = ['fixed_per_unit', 'per_m2', 'shared_total'];
const blank = () => ({ name: '', category: '', pricing: 'fixed_per_unit' as PricingModel, price: '', taxRateId: taxRates.value.find((r) => r.isDefault)?.id ?? null, recurring: 'true', appliesTo: [] as UnitKind[] });
const form = ref(blank());
const formError = ref('');
onMounted(async () => { await res.load(); taxRates.value = (await api.get<{ rows: TaxRate[] }>('/api/tax-rates')).rows; });
function toggleKind(k: UnitKind) { const i = form.value.appliesTo.indexOf(k); if (i >= 0) form.value.appliesTo.splice(i, 1); else form.value.appliesTo.push(k); }
async function submit() {
  formError.value = '';
  const price = toMinor(form.value.price);
  if (price === null) { formError.value = t('auth.errors.validation'); return; }
  try {
    await res.create({ name: form.value.name, category: form.value.category || null, pricing: form.value.pricing, defaultPriceMinor: price, taxRateId: form.value.taxRateId, recurring: form.value.recurring === 'true', appliesTo: form.value.appliesTo });
    open.value = false; form.value = blank();
  } catch { formError.value = t('auth.errors.validation'); }
}
</script>
<template>
  <div class="mb-4 flex items-center justify-between"><h1 class="text-2xl font-semibold">{{ t('services.title') }}</h1><AppButton data-test="add" @click="form = blank(); open = true">{{ t('services.add') }}</AppButton></div>
  <p v-if="res.error.value" class="mb-2 text-sm text-red-600" data-test="page-error">{{ t('app.error') }}</p>
  <DataTable :columns="[{ key: 'name', label: t('services.name') }, { key: 'pricing', label: t('services.pricing') }, { key: 'defaultPriceMinor', label: t('services.defaultPrice') }, { key: 'taxRateBp', label: t('services.taxRate') }, { key: 'recurring', label: t('services.recurring') }, { key: 'appliesTo', label: t('services.appliesTo') }]" :rows="res.rows.value">
    <template #cell-pricing="{ row }">{{ t(`services.pricingOptions.${row.pricing}`) }}</template>
    <template #cell-defaultPriceMinor="{ row }">{{ formatMoney(row.defaultPriceMinor) }}</template>
    <template #cell-taxRateBp="{ row }">{{ percentFromBp(row.taxRateBp) }}</template>
    <template #cell-recurring="{ row }">{{ row.recurring ? t('services.recurring') : t('services.oneTime') }}</template>
    <template #cell-appliesTo="{ row }">{{ row.appliesTo.length ? row.appliesTo.map((k) => t(`units.kinds.${k}`)).join(', ') : t('services.allKinds') }}</template>
    <template #actions="{ row }"><AppButton variant="danger" @click="swallow(res.remove(row.id))">{{ t('app.delete') }}</AppButton></template>
  </DataTable>
  <ModalDialog :open="open" :title="t('services.add')" @close="open = false">
    <form class="grid grid-cols-2 gap-3" @submit.prevent="submit">
      <AppInput v-model="form.name" :label="t('services.name')" data-test="service-name" class="col-span-2" />
      <AppInput v-model="form.category" :label="t('services.category')" />
      <AppSelect v-model="form.pricing" :label="t('services.pricing')" :options="pricings.map((p) => ({ value: p, label: t(`services.pricingOptions.${p}`) }))" data-test="service-pricing" />
      <AppInput v-model="form.price" :label="t('services.defaultPrice')" data-test="service-price" placeholder="300,00" />
      <AppSelect v-model="form.taxRateId" :label="t('services.taxRate')" :options="[{ value: null, label: t('services.noTax') }, ...taxRates.map((r) => ({ value: r.id, label: `${r.name} (${percentFromBp(r.rateBp)})` }))]" data-test="service-tax" />
      <AppSelect v-model="form.recurring" :label="t('services.recurring')" :options="[{ value: 'true', label: t('services.recurring') }, { value: 'false', label: t('services.oneTime') }]" />
      <fieldset class="col-span-2 text-sm"><legend class="mb-1 font-medium text-slate-700">{{ t('services.appliesTo') }}</legend>
        <label v-for="k in kinds" :key="k" class="mr-3 inline-flex items-center gap-1"><input type="checkbox" :checked="form.appliesTo.includes(k)" :data-test="`kind-${k}`" @change="toggleKind(k)" /> {{ t(`units.kinds.${k}`) }}</label>
        <p class="mt-1 text-xs text-slate-500">{{ t('services.allKinds') }}</p></fieldset>
      <p v-if="formError" class="col-span-2 text-sm text-red-600" data-test="error">{{ formError }}</p>
      <div class="col-span-2 flex justify-end gap-2"><AppButton variant="secondary" @click="open = false">{{ t('app.cancel') }}</AppButton><AppButton type="submit" data-test="submit">{{ t('app.create') }}</AppButton></div>
    </form>
  </ModalDialog>
</template>
