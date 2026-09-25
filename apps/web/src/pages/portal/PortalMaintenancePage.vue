<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { MaintenanceCategory, MaintenancePriority, PortalMaintenanceRequest, PortalMaintenanceRow } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import { usePortalStore } from '@/stores/portal';

const { t, te } = useI18n();
const portal = usePortalStore();

const CATEGORIES: MaintenanceCategory[] = ['plumbing', 'electrical', 'lift', 'heating', 'cleaning', 'common_area', 'other'];
const PRIORITIES: MaintenancePriority[] = ['low', 'normal', 'high', 'urgent'];

const rows = ref<PortalMaintenanceRow[]>([]);
const buildings = computed(() => portal.current?.buildings ?? []);
const blank = () => ({ buildingId: '', title: '', description: '', category: 'other' as MaintenanceCategory, priority: 'normal' as MaintenancePriority });
const form = ref(blank());
const file = ref<File | null>(null);
const error = ref('');
const saving = ref(false);

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('mk-MK');
const message = (e: unknown) => {
  const code = (e as { code?: string }).code ?? 'generic';
  return te(`maintenance.errors.${code}`) ? t(`maintenance.errors.${code}`) : t('app.error');
};

async function load() {
  const contactId = portal.selectedContactId;
  if (!contactId) { rows.value = []; return; }
  error.value = '';
  try { rows.value = (await api.get<{ rows: PortalMaintenanceRow[] }>('/api/portal/maintenance', { contactId })).rows; }
  catch (e) { error.value = message(e); }
}
onMounted(load);
watch(() => portal.selectedContactId, () => { form.value = blank(); void load(); });

function onFile(e: Event) { file.value = (e.target as HTMLInputElement).files?.[0] ?? null; }

async function submit() {
  const contactId = portal.selectedContactId;
  const buildingId = form.value.buildingId || buildings.value[0]?.id;
  if (!contactId || !buildingId || !form.value.title.trim()) { error.value = t('maintenance.errors.validation'); return; }
  error.value = '';
  saving.value = true;
  try {
    const created = await api.post<PortalMaintenanceRequest>('/api/portal/maintenance', {
      contactId, buildingId,
      title: form.value.title.trim(),
      description: form.value.description.trim(),
      category: form.value.category,
      priority: form.value.priority,
    });
    // The photo follows the request, because it has to be attached to something that exists.
    if (file.value) {
      const fd = new FormData();
      // Order matters: busboy only exposes the fields that precede the file part.
      fd.append('contactId', contactId);
      fd.append('file', file.value, file.value.name);
      await api.upload<PortalMaintenanceRequest>(`/api/portal/maintenance/${created.id}/photos`, fd);
    }
    form.value = blank();
    file.value = null;
    await load();
  } catch (e) { error.value = message(e); } finally { saving.value = false; }
}
</script>
<template>
  <h1 class="mb-1 text-2xl font-semibold">{{ t('portal.maintenance') }}</h1>
  <p class="mb-4 text-sm text-slate-600">{{ t('portal.maintenanceIntro') }}</p>
  <p v-if="error" class="mb-2 text-sm text-red-600" data-test="portal-page-error">{{ error }}</p>

  <form class="mb-6 space-y-3 rounded-xl bg-white p-4 shadow-sm" @submit.prevent="submit">
    <h2 class="font-semibold">{{ t('portal.maintenanceNew') }}</h2>
    <AppSelect v-if="buildings.length > 1" v-model="form.buildingId" :label="t('portal.buildings')" data-test="portal-maintenance-building"
      :options="buildings.map((b) => ({ value: b.id, label: b.name }))" />
    <AppInput v-model="form.title" :label="t('maintenance.requestTitle')" data-test="portal-maintenance-title" />
    <label class="block text-sm"><span class="mb-1 block font-medium text-slate-700">{{ t('maintenance.description') }}</span>
      <textarea v-model="form.description" rows="3" data-test="portal-maintenance-description"
        class="w-full rounded-md border border-slate-300 px-3 py-2 focus:border-emerald-500 focus:outline-none"></textarea></label>
    <div class="grid grid-cols-2 gap-3">
      <AppSelect v-model="form.category" :label="t('maintenance.category')" data-test="portal-maintenance-category"
        :options="CATEGORIES.map((c) => ({ value: c, label: t(`maintenance.categories.${c}`) }))" />
      <AppSelect v-model="form.priority" :label="t('maintenance.priority')" data-test="portal-maintenance-priority"
        :options="PRIORITIES.map((p) => ({ value: p, label: t(`maintenance.priorities.${p}`) }))" />
    </div>
    <label class="block text-sm"><span class="mb-1 block font-medium text-slate-700">{{ t('portal.maintenancePhoto') }}</span>
      <input type="file" class="text-sm" accept="image/png,image/jpeg" data-test="portal-maintenance-file" @change="onFile" /></label>
    <AppButton type="button" :loading="saving" data-test="portal-maintenance-submit" @click="submit">{{ t('portal.maintenanceSubmit') }}</AppButton>
  </form>

  <DataTable :columns="[{ key: 'createdAt', label: t('portal.date') }, { key: 'title', label: t('maintenance.requestTitle') }, { key: 'buildingName', label: t('portal.buildings') }, { key: 'status', label: t('portal.status') }]" :rows="rows">
    <template #cell-createdAt="{ row }">{{ fmtDate(row.createdAt) }}</template>
    <template #cell-title="{ row }">
      <RouterLink :to="`/portal/maintenance/${row.id}`" class="text-emerald-700 underline" data-test="portal-maintenance-link">
        <span data-test="portal-maintenance-row">{{ row.title }}</span>
      </RouterLink>
    </template>
    <template #cell-status="{ row }"><span data-test="portal-maintenance-status">{{ t(`maintenance.statuses.${row.status}`) }}</span></template>
  </DataTable>
  <p v-if="rows.length === 0" class="mt-2 text-sm text-slate-500">{{ t('portal.maintenanceEmpty') }}</p>
</template>
