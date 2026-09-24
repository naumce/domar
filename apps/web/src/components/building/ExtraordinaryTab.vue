<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { Distribution, DocumentMeta, ExtraordinaryCostResult, Fund, LegalEvent, UnitKind } from '@/api/types';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import { formatMoney, toMinor } from '@/utils/money';

const props = defineProps<{ buildingId: string }>();
const { t, te } = useI18n();
const KINDS: UnitKind[] = ['apartment', 'commercial', 'parking', 'storage', 'other'];
const form = ref({ description: '', amount: '', fund: 'reserve' as Fund, distribution: 'share' as Distribution, dueDays: '15', documentId: null as string | null, appliesTo: ['apartment', 'commercial'] as UnitKind[] });
const documents = ref<DocumentMeta[]>([]);
const history = ref<LegalEvent[]>([]);
const result = ref<ExtraordinaryCostResult | null>(null);
const error = ref('');
const saving = ref(false);

async function load() {
  documents.value = (await api.get<{ rows: DocumentMeta[] }>(`/api/buildings/${props.buildingId}/documents`)).rows;
  history.value = (await api.get<{ rows: LegalEvent[] }>(`/api/buildings/${props.buildingId}/legal-events`, { pageSize: 50 })).rows
    .filter((e) => e.kind === 'extraordinary_cost_distributed');
}
onMounted(load);
function toggleKind(k: UnitKind) { const i = form.value.appliesTo.indexOf(k); if (i >= 0) form.value.appliesTo.splice(i, 1); else form.value.appliesTo.push(k); }

/** Every refusal this endpoint can throw, named for the manager: the unit labels it lists, or the status of the period blocking it. */
function show(e: unknown) {
  const err = e as { code?: string; details?: { units?: string[]; status?: string } };
  const code = err.code ?? 'generic';
  const params = {
    units: (err.details?.units ?? []).join(', '),
    status: err.details?.status ? t(`periods.status.${err.details.status}`) : '',
  };
  error.value = te(`extraordinary.errors.${code}`) ? t(`extraordinary.errors.${code}`, params) : t('app.error');
}

async function submit() {
  error.value = ''; result.value = null;
  const amountMinor = toMinor(form.value.amount);
  if (amountMinor === null || amountMinor <= 0 || !form.value.description) { error.value = t('auth.errors.validation'); return; }
  saving.value = true;
  try {
    result.value = await api.post<ExtraordinaryCostResult>(`/api/buildings/${props.buildingId}/extraordinary-costs`, {
      description: form.value.description, amountMinor, fund: form.value.fund, distribution: form.value.distribution,
      appliesTo: form.value.appliesTo, dueDays: Number(form.value.dueDays) || 15, documentId: form.value.documentId || null,
    });
    form.value.description = ''; form.value.amount = '';
    await load();
  } catch (e) { show(e); } finally { saving.value = false; }
}
</script>
<template>
  <div class="space-y-4">
    <p class="text-sm text-slate-600">{{ t('extraordinary.intro') }}</p>
    <form class="grid grid-cols-3 items-end gap-3 rounded-xl bg-white p-4 shadow-sm" @submit.prevent="submit">
      <AppInput v-model="form.description" :label="t('billing.description')" data-test="extra-description" class="col-span-2" />
      <AppInput v-model="form.amount" :label="t('billing.amount')" data-test="extra-amount" placeholder="6.000,00" />
      <AppSelect v-model="form.fund" :label="t('billing.fund')" :options="[{ value: 'reserve', label: t('billing.reserve') }, { value: 'regular', label: t('billing.regular') }]" data-test="extra-fund" />
      <AppSelect v-model="form.distribution" :label="t('extraordinary.distribution')" :options="(['share', 'equal', 'area'] as Distribution[]).map((d) => ({ value: d, label: t(`extraordinary.distributions.${d}`) }))" data-test="extra-distribution" />
      <AppInput v-model="form.dueDays" :label="t('extraordinary.dueDays')" data-test="extra-due-days" />
      <AppSelect v-model="form.documentId" :label="t('contracts.document')" :options="[{ value: null, label: t('contracts.noDocument') }, ...documents.map((d) => ({ value: d.id, label: d.title }))]" data-test="extra-document" />
      <fieldset class="col-span-2 text-sm"><legend class="mb-1 font-medium text-slate-700">{{ t('services.appliesTo') }}</legend>
        <label v-for="k in KINDS" :key="k" class="mr-3 inline-flex items-center gap-1"><input type="checkbox" :checked="form.appliesTo.includes(k)" :data-test="`extra-kind-${k}`" @change="toggleKind(k)" /> {{ t(`units.kinds.${k}`) }}</label></fieldset>
      <AppButton type="button" :loading="saving" data-test="extra-submit" @click="submit">{{ t('extraordinary.submit') }}</AppButton>
    </form>
    <p v-if="error" class="text-sm text-red-600" data-test="extra-error">{{ error }}</p>
    <p v-if="result" class="text-sm text-emerald-700" data-test="extra-result">
      {{ t('extraordinary.done', { count: result.invoiceCount, period: result.period, total: formatMoney(result.totalMinor) }) }}
    </p>
    <div>
      <h3 class="mb-2 font-semibold">{{ t('extraordinary.history') }}</h3>
      <ul class="divide-y divide-slate-100 rounded-xl bg-white shadow-sm">
        <li v-if="history.length === 0" class="px-4 py-6 text-center text-slate-500">{{ t('app.empty') }}</li>
        <li v-for="e in history" :key="e.id" class="flex items-center justify-between px-4 py-2 text-sm" data-test="extra-history-row">
          <span>{{ String(e.evidence.period) }} · {{ formatMoney(Number(e.evidence.amountMinor)) }} · {{ t(`extraordinary.distributions.${String(e.evidence.distribution)}`) }}</span>
          <span class="text-slate-500">{{ t('extraordinary.invoices', { count: Number(e.evidence.invoiceCount) }) }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>
