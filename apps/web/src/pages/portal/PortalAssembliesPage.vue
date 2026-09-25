<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { PortalAssemblyRow } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import { usePortalStore } from '@/stores/portal';

const { t } = useI18n();
const portal = usePortalStore();
const rows = ref<PortalAssemblyRow[]>([]);
const error = ref('');

async function load() {
  const contactId = portal.selectedContactId;
  if (!contactId) { rows.value = []; return; }
  error.value = '';
  try { rows.value = (await api.get<{ rows: PortalAssemblyRow[] }>('/api/portal/assemblies', { contactId })).rows; }
  catch { error.value = t('app.error'); }
}
onMounted(load);
watch(() => portal.selectedContactId, load);
const dateTime = (d: string) => new Date(d).toLocaleString('mk-MK', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
</script>
<template>
  <h1 class="mb-4 text-2xl font-semibold">{{ t('portal.assemblies') }}</h1>
  <p v-if="error" class="mb-2 text-sm text-red-600" data-test="portal-page-error">{{ error }}</p>
  <DataTable :columns="[{ key: 'scheduledAt', label: t('portal.date') }, { key: 'buildingName', label: t('portal.buildings') }, { key: 'location', label: t('portal.assemblyPlace') }, { key: 'status', label: t('portal.status') }]" :rows="rows">
    <template #cell-scheduledAt="{ row }">
      <RouterLink :to="`/portal/assemblies/${row.id}`" class="text-emerald-700 underline" data-test="portal-assembly-link">
        <span data-test="portal-assembly-row">{{ dateTime(row.scheduledAt) }}</span>
      </RouterLink>
    </template>
    <template #cell-status="{ row }"><span data-test="portal-assembly-status">{{ t(`assemblies.statuses.${row.status}`) }}</span></template>
  </DataTable>
</template>
