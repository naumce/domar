<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { BuildingContract, ContractKind, DocumentMeta, Supplier } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import { formatMoney, toMinor } from '@/utils/money';

const props = defineProps<{ buildingId: string }>();
const { t, te } = useI18n();
const KINDS: ContractKind[] = ['management', 'service', 'insurance', 'other'];
const rows = ref<BuildingContract[]>([]);
const suppliers = ref<Supplier[]>([]);
const documents = ref<DocumentMeta[]>([]);
const form = ref({ kind: 'management' as ContractKind, title: '', startsOn: '', endsOn: '', supplierId: null as string | null, documentId: null as string | null, noticeDays: '30', amount: '' });
const error = ref('');
const saving = ref(false);
const fmtDate = (v: string | null) => (v ? new Date(v).toLocaleDateString('mk-MK') : '—');

async function load() {
  rows.value = (await api.get<{ rows: BuildingContract[] }>(`/api/buildings/${props.buildingId}/contracts`)).rows;
  suppliers.value = (await api.get<{ rows: Supplier[] }>('/api/suppliers')).rows;
  documents.value = (await api.get<{ rows: DocumentMeta[] }>(`/api/buildings/${props.buildingId}/documents`)).rows;
}
onMounted(load);

async function submit() {
  error.value = ''; saving.value = true;
  try {
    const amountMinor = form.value.amount ? toMinor(form.value.amount) : null;
    await api.post(`/api/buildings/${props.buildingId}/contracts`, {
      kind: form.value.kind, title: form.value.title, startsOn: form.value.startsOn,
      endsOn: form.value.endsOn || null, supplierId: form.value.supplierId || null, documentId: form.value.documentId || null,
      noticeDays: Number(form.value.noticeDays) || 0, amountMinor,
    });
    form.value = { kind: 'management', title: '', startsOn: '', endsOn: '', supplierId: null, documentId: null, noticeDays: '30', amount: '' };
    await load();
  } catch (e) {
    const code = (e as { code?: string }).code ?? 'generic';
    error.value = te(`contracts.errors.${code}`) ? t(`contracts.errors.${code}`) : t('app.error');
  } finally { saving.value = false; }
}

async function remove(id: string) {
  if (!window.confirm(t('app.confirmDelete'))) return;
  try { await api.del(`/api/buildings/${props.buildingId}/contracts/${id}`); await load(); } catch { error.value = t('app.error'); }
}
</script>
<template>
  <div class="space-y-4">
    <form class="grid grid-cols-4 items-end gap-3 rounded-xl bg-white p-4 shadow-sm" @submit.prevent="submit">
      <AppSelect v-model="form.kind" :label="t('contracts.kind')" :options="KINDS.map((k) => ({ value: k, label: t(`contracts.kinds.${k}`) }))" data-test="contract-kind" />
      <AppInput v-model="form.title" :label="t('contracts.contractTitle')" data-test="contract-title" />
      <AppInput v-model="form.startsOn" :label="t('contracts.startsOn')" type="date" data-test="contract-starts" />
      <AppInput v-model="form.endsOn" :label="t('contracts.endsOn')" type="date" data-test="contract-ends" />
      <AppSelect v-model="form.supplierId" :label="t('contracts.supplier')" :options="[{ value: null, label: t('contracts.ownContract') }, ...suppliers.map((s) => ({ value: s.id, label: s.name }))]" data-test="contract-supplier" />
      <AppSelect v-model="form.documentId" :label="t('contracts.document')" :options="[{ value: null, label: t('contracts.noDocument') }, ...documents.map((d) => ({ value: d.id, label: d.title }))]" data-test="contract-document" />
      <AppInput v-model="form.noticeDays" :label="t('contracts.noticeDays')" data-test="contract-notice" />
      <div class="flex items-end gap-2"><AppInput v-model="form.amount" :label="t('billing.amount')" data-test="contract-amount" /><AppButton type="button" :loading="saving" data-test="contract-submit" @click="submit">{{ t('app.create') }}</AppButton></div>
    </form>
    <p v-if="error" class="text-sm text-red-600" data-test="contract-error">{{ error }}</p>
    <DataTable :columns="[{ key: 'title', label: t('contracts.contractTitle') }, { key: 'kind', label: t('contracts.kind') }, { key: 'supplier', label: t('contracts.supplier') }, { key: 'startsOn', label: t('contracts.startsOn') }, { key: 'endsOn', label: t('contracts.endsOn') }, { key: 'amountMinor', label: t('billing.amount') }]" :rows="rows">
      <template #cell-kind="{ row }">{{ t(`contracts.kinds.${row.kind}`) }}</template>
      <template #cell-supplier="{ row }">{{ row.supplier ? row.supplier.name : t('contracts.ownContract') }}</template>
      <template #cell-startsOn="{ row }">{{ fmtDate(row.startsOn) }}</template>
      <template #cell-endsOn="{ row }">{{ fmtDate(row.endsOn) }}</template>
      <template #cell-amountMinor="{ row }">{{ row.amountMinor === null ? '—' : formatMoney(row.amountMinor) }}</template>
      <template #actions="{ row }"><AppButton variant="danger" @click="remove(row.id)">{{ t('app.delete') }}</AppButton></template>
    </DataTable>
  </div>
</template>
