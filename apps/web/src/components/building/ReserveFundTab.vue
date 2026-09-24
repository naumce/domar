<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { DocumentMeta, Expense, FundTransaction, ReserveFundState, Supplier, UnitKind } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import { formatMoney, toMinor } from '@/utils/money';

const props = defineProps<{ buildingId: string }>();
const { t } = useI18n();
const base = `/api/buildings/${props.buildingId}/reserve-fund`;
const state = ref<ReserveFundState | null>(null);
const expenses = ref<Expense[]>([]);
const transactions = ref<FundTransaction[]>([]);
const suppliers = ref<Supplier[]>([]);
const documents = ref<DocumentMeta[]>([]);
const kinds: UnitKind[] = ['apartment', 'commercial', 'parking', 'storage', 'other'];
const form = ref({ basis: 'per_unit' as 'per_unit' | 'per_m2', amount: '', appliesTo: [] as UnitKind[], active: false });
const opening = ref('');
const expense = ref({ description: '', supplierText: '', supplierId: null as string | null, documentId: null as string | null, amount: '', paidAt: new Date().toISOString().slice(0, 10) });
const error = ref('');
async function load() {
  try {
    state.value = await api.get<ReserveFundState>(base);
    expenses.value = (await api.get<{ rows: Expense[] }>(`${base}/expenses`)).rows;
    transactions.value = (await api.get<{ rows: FundTransaction[] }>(`${base}/transactions`)).rows;
    suppliers.value = (await api.get<{ rows: Supplier[] }>('/api/suppliers')).rows;
    documents.value = (await api.get<{ rows: DocumentMeta[] }>(`/api/buildings/${props.buildingId}/documents`)).rows;
    const s = state.value.setting;
    if (s) form.value = { basis: s.basis, amount: (s.amountMinor / 100).toFixed(2).replace('.', ','), appliesTo: [...s.appliesTo], active: s.active };
  } catch { error.value = t('app.error'); }
}
onMounted(load);
function toggleKind(k: UnitKind) { const i = form.value.appliesTo.indexOf(k); if (i >= 0) form.value.appliesTo.splice(i, 1); else form.value.appliesTo.push(k); }
async function saveSetting() {
  error.value = '';
  const amountMinor = toMinor(form.value.amount);
  if (amountMinor === null) { error.value = t('auth.errors.validation'); return; }
  try { await api.put(base, { basis: form.value.basis, amountMinor, appliesTo: form.value.appliesTo, active: form.value.active }); await load(); } catch { error.value = t('app.error'); }
}
async function addOpening() {
  const amountMinor = toMinor(opening.value);
  if (amountMinor === null) { error.value = t('auth.errors.validation'); return; }
  try { await api.post(`${base}/opening-balance`, { amountMinor }); opening.value = ''; await load(); } catch { error.value = t('app.error'); }
}
async function addExpense() {
  const amountMinor = toMinor(expense.value.amount);
  if (amountMinor === null || !expense.value.description) { error.value = t('auth.errors.validation'); return; }
  try {
    await api.post(`${base}/expenses`, { fund: 'reserve', description: expense.value.description, supplierText: expense.value.supplierText || null, supplierId: expense.value.supplierId || null, documentId: expense.value.documentId || null, amountMinor, paidAt: new Date(expense.value.paidAt).toISOString() });
    expense.value = { description: '', supplierText: '', supplierId: null, documentId: null, amount: '', paidAt: new Date().toISOString().slice(0, 10) }; await load();
  } catch { error.value = t('app.error'); }
}
async function voidExpense(id: string) {
  const reason = window.prompt(t('reserveFund.voidReason'));
  if (!reason) return;
  try { await api.post(`${base}/expenses/${id}/void`, { reason }); await load(); } catch { error.value = t('app.error'); }
}
</script>
<template>
  <div v-if="state" class="space-y-6">
    <div class="grid grid-cols-2 gap-4">
      <div class="rounded-xl bg-white p-4 shadow-sm"><div class="text-sm text-slate-500">{{ t('reserveFund.balance') }}</div><div class="text-2xl font-semibold" data-test="rf-balance">{{ formatMoney(state.balanceMinor) }}</div></div>
      <div class="rounded-xl bg-white p-4 shadow-sm"><div class="text-sm text-slate-500">{{ t('reserveFund.billed') }}</div><div class="text-2xl font-semibold">{{ formatMoney(state.contributionsBilledMinor) }}</div></div>
    </div>
    <p v-if="error" class="text-sm text-red-600" data-test="error">{{ error }}</p>
    <form class="grid grid-cols-4 items-end gap-3 rounded-xl bg-white p-4 shadow-sm" @submit.prevent="saveSetting">
      <AppSelect v-model="form.basis" :label="t('reserveFund.basis')" :options="[{ value: 'per_unit', label: t('reserveFund.perUnit') }, { value: 'per_m2', label: t('reserveFund.perM2') }]" data-test="rf-basis" />
      <AppInput v-model="form.amount" :label="t('billing.amount')" data-test="rf-amount" placeholder="10,00" />
      <label class="text-sm"><input v-model="form.active" type="checkbox" data-test="rf-active" /> {{ t('reserveFund.active') }}</label>
      <AppButton type="submit" data-test="rf-save">{{ t('app.save') }}</AppButton>
      <fieldset class="col-span-4 text-sm"><legend class="mb-1 font-medium text-slate-700">{{ t('services.appliesTo') }}</legend>
        <label v-for="k in kinds" :key="k" class="mr-3 inline-flex items-center gap-1"><input type="checkbox" :checked="form.appliesTo.includes(k)" :data-test="`rf-kind-${k}`" @change="toggleKind(k)" /> {{ t(`units.kinds.${k}`) }}</label></fieldset>
    </form>
    <form class="flex items-end gap-3 rounded-xl bg-white p-4 shadow-sm" @submit.prevent="addOpening">
      <AppInput v-model="opening" :label="t('reserveFund.openingBalance')" data-test="rf-opening" placeholder="35.000,00" class="flex-1" />
      <AppButton type="submit" variant="secondary" data-test="rf-opening-submit">{{ t('reserveFund.addOpening') }}</AppButton>
    </form>
    <div>
      <h3 class="mb-2 font-semibold">{{ t('reserveFund.expenses') }}</h3>
      <form class="mb-3 grid grid-cols-6 items-end gap-3" @submit.prevent="addExpense">
        <AppInput v-model="expense.description" :label="t('billing.description')" data-test="exp-description" class="col-span-2" />
        <AppSelect v-model="expense.supplierId" :label="t('reserveFund.supplier')" :options="[{ value: null, label: t('reserveFund.noSupplier') }, ...suppliers.map((s) => ({ value: s.id, label: s.name }))]" data-test="exp-supplier-id" />
        <AppSelect v-model="expense.documentId" :label="t('contracts.document')" :options="[{ value: null, label: t('contracts.noDocument') }, ...documents.map((d) => ({ value: d.id, label: d.title }))]" data-test="exp-document-id" />
        <AppInput v-model="expense.amount" :label="t('billing.amount')" data-test="exp-amount" />
        <div class="flex items-end gap-2"><AppInput v-model="expense.paidAt" :label="t('reserveFund.paidAt')" type="date" /><AppButton type="submit" variant="secondary" data-test="exp-submit">{{ t('reserveFund.addExpense') }}</AppButton></div>
      </form>
      <DataTable :columns="[{ key: 'paidAt', label: t('reserveFund.paidAt') }, { key: 'description', label: t('billing.description') }, { key: 'supplierText', label: t('reserveFund.supplier') }, { key: 'amountMinor', label: t('billing.amount') }]" :rows="expenses">
        <template #cell-paidAt="{ row }">{{ new Date(row.paidAt).toLocaleDateString('mk-MK') }}</template>
        <template #cell-amountMinor="{ row }"><span :class="{ 'line-through text-slate-400': row.voidedAt }">{{ formatMoney(row.amountMinor) }}</span> <span v-if="row.voidedAt" class="text-xs text-slate-500">({{ t('reserveFund.voided') }})</span></template>
        <template #actions="{ row }"><AppButton v-if="!row.voidedAt" variant="danger" @click="voidExpense(row.id)">{{ t('reserveFund.void') }}</AppButton></template>
      </DataTable>
    </div>
    <div>
      <h3 class="mb-2 font-semibold">{{ t('reserveFund.transactions') }}</h3>
      <DataTable :columns="[{ key: 'bookedAt', label: t('reserveFund.paidAt') }, { key: 'kind', label: t('billing.description') }, { key: 'description', label: '' }, { key: 'amountMinor', label: t('billing.amount') }]" :rows="transactions">
        <template #cell-bookedAt="{ row }">{{ new Date(row.bookedAt).toLocaleDateString('mk-MK') }}</template>
        <template #cell-kind="{ row }">{{ t(`reserveFund.kind.${row.kind}`) }}</template>
        <template #cell-amountMinor="{ row }">{{ formatMoney(row.amountMinor) }}</template>
      </DataTable>
    </div>
  </div>
  <p v-else-if="error" class="text-sm text-red-600" data-test="page-error">{{ error }}</p>
</template>
