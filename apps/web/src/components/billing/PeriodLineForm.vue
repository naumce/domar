<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Fund, PeriodLine, PricingModel, Service, TaxRate, UnitKind } from '@/api/types';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import { percentFromBp, toMinor } from '@/utils/money';

export interface LinePayload { serviceId?: string; description: string; pricing: PricingModel; quantity: number; unitPriceMinor: number; taxRateId?: string | null; appliesTo: UnitKind[]; fund: Fund; note?: string }
const props = defineProps<{ services: Service[]; taxRates: TaxRate[]; initial?: PeriodLine | undefined; requireNote: boolean }>();
const emit = defineEmits<{ submit: [payload: LinePayload] }>();
const { t } = useI18n();
const fmt = (minor: number) => (minor / 100).toFixed(2).replace('.', ',');
const kinds: UnitKind[] = ['apartment', 'commercial', 'parking', 'storage', 'other'];
function findRateForBp(bp: number): TaxRate | null {
  return props.taxRates.find((r) => r.rateBp === bp && r.isActive) ?? props.taxRates.find((r) => r.rateBp === bp) ?? null;
}
const serviceId = ref<string | null>(props.initial?.serviceId ?? null);
const description = ref(props.initial?.description ?? '');
const pricing = ref<PricingModel>(props.initial?.pricing ?? 'fixed_per_unit');
const quantity = ref(props.initial ? String(props.initial.quantity).replace('.', ',') : '1');
const price = ref(props.initial ? fmt(props.initial.unitPriceMinor) : '');
const taxRateId = ref<string | null>(props.initial ? (findRateForBp(props.initial.taxRateBp)?.id ?? null) : (props.taxRates.find((r) => r.isDefault)?.id ?? null));
const taxTouched = ref(false);
watch(taxRateId, () => { taxTouched.value = true; });
const appliesTo = ref<UnitKind[]>([...(props.initial?.appliesTo ?? [])]);
const fund = ref<Fund>(props.initial?.fund ?? 'regular');
const note = ref(props.initial?.note ?? '');
const error = ref('');
const taxRateOptions = computed(() => {
  const active = props.taxRates.filter((r) => r.isActive);
  const matched = props.initial ? findRateForBp(props.initial.taxRateBp) : null;
  const extra = matched && !matched.isActive && !active.some((r) => r.id === matched.id) ? [matched] : [];
  return [{ value: null, label: t('services.noTax') }, ...[...active, ...extra].map((r) => ({ value: r.id, label: `${r.name} (${percentFromBp(r.rateBp)})` }))];
});
watch(serviceId, (id) => {
  const s = props.services.find((x) => x.id === id);
  if (!s) return;
  description.value = s.name; pricing.value = s.pricing; price.value = fmt(s.defaultPriceMinor); appliesTo.value = [...s.appliesTo];
  taxRateId.value = s.taxRateId ?? null;
});
function toggleKind(k: UnitKind) { const i = appliesTo.value.indexOf(k); if (i >= 0) appliesTo.value.splice(i, 1); else appliesTo.value.push(k); }
function submit() {
  error.value = '';
  if (props.requireNote && !note.value.trim()) { error.value = t('periods.noteRequired'); return; }
  const unitPriceMinor = toMinor(price.value); const q = Number(quantity.value.replace(',', '.'));
  if (!description.value.trim() || unitPriceMinor === null || !Number.isFinite(q) || q <= 0) { error.value = t('auth.errors.validation'); return; }
  const payload: LinePayload = { description: description.value.trim(), pricing: pricing.value, quantity: q, unitPriceMinor, appliesTo: [...appliesTo.value], fund: fund.value };
  const omitTax = props.initial && taxRateId.value === null && props.initial.taxRateBp > 0 && !taxTouched.value;
  if (!omitTax) payload.taxRateId = taxRateId.value;
  if (serviceId.value && !props.initial) payload.serviceId = serviceId.value;
  if (note.value.trim()) payload.note = note.value.trim();
  emit('submit', payload);
}
</script>
<template>
  <form class="grid grid-cols-2 gap-3" @submit.prevent="submit">
    <AppSelect v-if="!initial" v-model="serviceId" :label="t('periods.fromService')" :options="[{ value: null, label: '—' }, ...services.map((s) => ({ value: s.id, label: s.name }))]" data-test="line-service" class="col-span-2" />
    <AppInput v-model="description" :label="t('billing.description')" data-test="line-description" class="col-span-2" />
    <AppSelect v-model="pricing" :label="t('services.pricing')" :options="(['fixed_per_unit', 'per_m2', 'shared_total'] as PricingModel[]).map((p) => ({ value: p, label: t(`services.pricingOptions.${p}`) }))" data-test="line-pricing" />
    <AppInput v-model="quantity" :label="t('billing.quantity')" data-test="line-quantity" />
    <AppInput v-model="price" :label="t('billing.unitPrice')" data-test="line-price" />
    <AppSelect v-model="taxRateId" :label="t('services.taxRate')" :options="taxRateOptions" data-test="line-tax" />
    <AppSelect v-model="fund" :label="t('billing.fund')" :options="[{ value: 'regular', label: t('billing.regular') }, { value: 'reserve', label: t('billing.reserve') }]" data-test="line-fund" />
    <fieldset class="col-span-2 text-sm"><legend class="mb-1 font-medium text-slate-700">{{ t('services.appliesTo') }}</legend>
      <label v-for="k in kinds" :key="k" class="mr-3 inline-flex items-center gap-1"><input type="checkbox" :checked="appliesTo.includes(k)" @change="toggleKind(k)" /> {{ t(`units.kinds.${k}`) }}</label></fieldset>
    <AppInput v-model="note" :label="t('periods.note')" data-test="line-note" class="col-span-2" />
    <p v-if="error" class="col-span-2 text-sm text-red-600" data-test="error">{{ error }}</p>
    <div class="col-span-2 flex justify-end"><AppButton type="submit" data-test="line-submit">{{ t('app.save') }}</AppButton></div>
  </form>
</template>
