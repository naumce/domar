<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { api } from '@/api/client';
import type { Building, Contact, Unit } from '@/api/types';
import AssembliesTab from '@/components/building/AssembliesTab.vue';
import BuildingServicesTab from '@/components/building/BuildingServicesTab.vue';
import ComplianceTab from '@/components/building/ComplianceTab.vue';
import ContractsTab from '@/components/building/ContractsTab.vue';
import DocumentsTab from '@/components/building/DocumentsTab.vue';
import ExtraordinaryTab from '@/components/building/ExtraordinaryTab.vue';
import ImportTab from '@/components/building/ImportTab.vue';
import MaintenanceTab from '@/components/building/MaintenanceTab.vue';
import OpeningBalancesTab from '@/components/building/OpeningBalancesTab.vue';
import PeriodsTab from '@/components/building/PeriodsTab.vue';
import RemindersTab from '@/components/building/RemindersTab.vue';
import ReportsTab from '@/components/building/ReportsTab.vue';
import ReserveFundTab from '@/components/building/ReserveFundTab.vue';
import StatementsTab from '@/components/building/StatementsTab.vue';
import DataTable from '@/components/DataTable.vue';
import ModalDialog from '@/components/ModalDialog.vue';
import AppButton from '@/components/ui/AppButton.vue';
import UnitForm, { type UnitCreatePayload } from '@/components/units/UnitForm.vue';
import { swallow, useResource } from '@/composables/useResource';
import { useAuthStore } from '@/stores/auth';
import { formatNumber } from '@/utils/money';

const props = defineProps<{ id: string }>();
const { t, te } = useI18n();
const auth = useAuthStore();
const building = ref<Building | null>(null);
const contacts = ref<Contact[]>([]);
const units = useResource<Unit>(`/api/buildings/${props.id}/units`);
const open = ref(false); const editing = ref<Unit | null>(null); const formError = ref<string | null>(null);
const route = useRoute(); const router = useRouter();
const ALL_TABS = ['compliance', 'units', 'services', 'reserve-fund', 'opening-balances', 'periods', 'statements', 'reminders', 'assemblies', 'maintenance', 'reports', 'documents', 'contracts', 'extraordinary', 'import'] as const;
type TabKey = (typeof ALL_TABS)[number];
// Spec §10: a technician's job here is maintenance. The other tabs read endpoints their role is
// refused, so they are not drawn at all rather than drawn blank; an old link falls back to compliance.
const TECHNICIAN_TABS: readonly TabKey[] = ['compliance', 'units', 'maintenance'];
const tabs = computed<readonly TabKey[]>(() => (auth.user?.role === 'technician' ? TECHNICIAN_TABS : ALL_TABS));
const tab = computed(() => (tabs.value.includes(route.query.tab as TabKey) ? (route.query.tab as TabKey) : 'compliance'));
const tabLabel = (k: string) => ({ compliance: t('compliance.title'), units: t('units.title'), services: t('buildingServices.title'), 'reserve-fund': t('reserveFund.title'), 'opening-balances': t('openingBalances.title'), periods: t('periods.title'), statements: t('statements.title'), reminders: t('reminders.title'), assemblies: t('assemblies.title'), maintenance: t('maintenance.title'), reports: t('reports.title'), documents: t('documents.title'), contracts: t('contracts.title'), extraordinary: t('extraordinary.title'), import: t('imports.title') })[k as TabKey];

async function loadContactsAndUnits() {
  contacts.value = (await api.get<{ rows: Contact[] }>('/api/contacts', { pageSize: 200 })).rows;
  await units.load();
}
onMounted(async () => {
  building.value = await api.get<Building>(`/api/buildings/${props.id}`);
  await loadContactsAndUnits();
});
function openNew() { editing.value = null; formError.value = null; open.value = true; }
function openEdit(u: Unit) { editing.value = u; formError.value = null; open.value = true; }
async function onSubmit(payload: UnitCreatePayload) {
  try {
    if (editing.value) await units.update(editing.value.id, payload); else await units.create(payload);
    open.value = false;
  } catch (e) {
    const code = (e as { code?: string }).code ?? 'generic';
    formError.value = te(`units.errors.${code}`) ? t(`units.errors.${code}`) : code === 'validation' ? t('auth.errors.validation') : t('app.error');
  }
}
</script>
<template>
  <div v-if="building">
    <h1 class="text-2xl font-semibold">{{ building.name }}</h1>
    <p class="mb-6 text-slate-600">{{ building.address }}, {{ building.postalCode }} {{ building.city }}</p>
    <nav class="mb-4 flex gap-2 border-b border-slate-200">
      <button v-for="k in tabs" :key="k" class="-mb-px border-b-2 px-3 py-2 text-sm" :class="tab === k ? 'border-emerald-600 font-medium text-emerald-800' : 'border-transparent text-slate-600'" :data-test="`tab-${k}`" @click="router.replace({ query: { ...route.query, tab: k } })">{{ tabLabel(k) }}</button>
    </nav>
    <ComplianceTab v-if="tab === 'compliance'" :building-id="id" />
    <div v-else-if="tab === 'units'">
      <div class="mb-3 flex items-center justify-between"><h2 class="text-lg font-semibold">{{ t('units.title') }} <span class="text-slate-500">{{ units.rows.value.length }}</span></h2><AppButton data-test="add-unit" @click="openNew">{{ t('units.add') }}</AppButton></div>
      <p v-if="units.error.value" class="mb-2 text-sm text-red-600" data-test="page-error">{{ t('app.error') }}</p>
      <DataTable :columns="[{ key: 'label', label: t('units.label') }, { key: 'floor', label: t('units.floor') }, { key: 'kind', label: t('units.kind') }, { key: 'areaM2', label: t('units.areaM2') }, { key: 'owner', label: t('units.owner') }]" :rows="units.rows.value">
        <template #cell-areaM2="{ row }">{{ formatNumber(row.areaM2) }}</template>
        <template #cell-kind="{ row }">{{ t(`units.kinds.${row.kind}`) }}</template>
        <template #cell-owner="{ row }">{{ row.owner ? `${row.owner.firstName} ${row.owner.lastName}` : '' }}</template>
        <template #actions="{ row }"><AppButton variant="secondary" @click="openEdit(row)">{{ t('app.edit') }}</AppButton><AppButton variant="danger" class="ml-2" @click="swallow(units.remove(row.id))">{{ t('app.delete') }}</AppButton></template>
      </DataTable>
      <ModalDialog :open="open" :title="editing ? t('app.edit') : t('units.add')" @close="open = false">
        <UnitForm :key="editing?.id ?? 'new'" :units="units.rows.value" :contacts="contacts" :initial="editing ?? undefined" :error="formError" @submit="onSubmit" />
      </ModalDialog>
    </div>
    <BuildingServicesTab v-else-if="tab === 'services'" :building-id="id" />
    <ReserveFundTab v-else-if="tab === 'reserve-fund'" :building-id="id" />
    <OpeningBalancesTab v-else-if="tab === 'opening-balances'" :building-id="id" />
    <StatementsTab v-else-if="tab === 'statements'" :building-id="id" />
    <RemindersTab v-else-if="tab === 'reminders'" :building-id="id" />
    <AssembliesTab v-else-if="tab === 'assemblies'" :building-id="id" />
    <MaintenanceTab v-else-if="tab === 'maintenance'" :building-id="id" />
    <ReportsTab v-else-if="tab === 'reports'" :building-id="id" />
    <DocumentsTab v-else-if="tab === 'documents'" :building-id="id" />
    <ContractsTab v-else-if="tab === 'contracts'" :building-id="id" />
    <ExtraordinaryTab v-else-if="tab === 'extraordinary'" :building-id="id" />
    <ImportTab v-else-if="tab === 'import'" :building-id="id" @imported="swallow(loadContactsAndUnits())" />
    <PeriodsTab v-else :building-id="id" />
  </div>
  <p v-else>{{ t('app.loading') }}</p>
</template>
