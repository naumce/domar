<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { Building, OwnerStatement } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import { formatMoney } from '@/utils/money';

const props = defineProps<{ id: string }>();
const { t } = useI18n();
const buildings = ref<Building[]>([]);
const buildingId = ref<string | null>(null);
const statement = ref<OwnerStatement | null>(null);
const error = ref('');

async function load() {
  error.value = '';
  try {
    statement.value = await api.get<OwnerStatement>(`/api/contacts/${props.id}/statement`, { buildingId: buildingId.value ?? undefined });
  } catch { error.value = t('app.error'); }
}
onMounted(async () => {
  buildings.value = (await api.get<{ rows: Building[] }>('/api/buildings')).rows;
  await load();
});
watch(buildingId, load);
</script>
<template>
  <h1 v-if="statement" class="mb-1 text-2xl font-semibold">{{ statement.contact.firstName }} {{ statement.contact.lastName }}</h1>
  <p class="mb-4 text-slate-600">{{ t('contacts.statement') }}</p>
  <AppSelect v-model="buildingId" :label="t('invoices.building')" :options="[{ value: null, label: t('contacts.allBuildings') }, ...buildings.map((b) => ({ value: b.id, label: b.name }))]" class="mb-4 max-w-xs" />
  <p v-if="error" class="mb-2 text-sm text-red-600" data-test="page-error">{{ error }}</p>
  <DataTable v-if="statement" :columns="[{ key: 'bookedAt', label: t('contacts.date') }, { key: 'label', label: t('billing.description') }, { key: 'kind', label: t('billing.status') }, { key: 'fund', label: t('billing.fund') }, { key: 'amountMinor', label: t('billing.amount') }, { key: 'balanceMinor', label: t('contacts.balance') }]" :rows="statement.rows">
    <template #cell-bookedAt="{ row }">{{ new Date(row.bookedAt).toLocaleDateString('mk-MK') }}</template>
    <template #cell-kind="{ row }">{{ t(`ledger.kind.${row.kind}`) }}</template>
    <template #cell-fund="{ row }">{{ t(`billing.${row.fund}`) }}</template>
    <template #cell-amountMinor="{ row }">{{ formatMoney(row.amountMinor) }}</template>
    <template #cell-balanceMinor="{ row }">{{ formatMoney(row.balanceMinor) }}</template>
  </DataTable>
  <p v-if="statement" class="mt-4 text-right text-lg font-semibold">{{ t('contacts.balance') }}: <span data-test="owner-balance">{{ formatMoney(statement.balanceMinor) }}</span></p>
</template>
