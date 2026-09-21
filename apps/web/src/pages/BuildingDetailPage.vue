<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { Building, Contact, Unit } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import ModalDialog from '@/components/ModalDialog.vue';
import AppButton from '@/components/ui/AppButton.vue';
import UnitForm, { type UnitCreatePayload } from '@/components/units/UnitForm.vue';
import { swallow, useResource } from '@/composables/useResource';

const props = defineProps<{ id: string }>();
const { t, te } = useI18n();
const building = ref<Building | null>(null);
const contacts = ref<Contact[]>([]);
const units = useResource<Unit>(`/api/buildings/${props.id}/units`);
const open = ref(false); const editing = ref<Unit | null>(null); const formError = ref<string | null>(null);

onMounted(async () => {
  building.value = await api.get<Building>(`/api/buildings/${props.id}`);
  contacts.value = (await api.get<{ rows: Contact[] }>('/api/contacts', { pageSize: 200 })).rows;
  await units.load();
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
    <div class="mb-3 flex items-center justify-between"><h2 class="text-lg font-semibold">{{ t('units.title') }} <span class="text-slate-500">{{ units.rows.value.length }}</span></h2><AppButton data-test="add-unit" @click="openNew">{{ t('units.add') }}</AppButton></div>
    <p v-if="units.error.value" class="mb-2 text-sm text-red-600" data-test="page-error">{{ t('app.error') }}</p>
    <DataTable :columns="[{ key: 'label', label: t('units.label') }, { key: 'floor', label: t('units.floor') }, { key: 'kind', label: t('units.kind') }, { key: 'areaM2', label: t('units.areaM2') }, { key: 'owner', label: t('units.owner') }]" :rows="units.rows.value">
      <template #cell-kind="{ row }">{{ t(`units.kinds.${row.kind}`) }}</template>
      <template #cell-owner="{ row }">{{ row.owner ? `${row.owner.firstName} ${row.owner.lastName}` : '' }}</template>
      <template #actions="{ row }"><AppButton variant="secondary" @click="openEdit(row)">{{ t('app.edit') }}</AppButton><AppButton variant="danger" class="ml-2" @click="swallow(units.remove(row.id))">{{ t('app.delete') }}</AppButton></template>
    </DataTable>
    <ModalDialog :open="open" :title="editing ? t('app.edit') : t('units.add')" @close="open = false">
      <UnitForm :key="editing?.id ?? 'new'" :units="units.rows.value" :contacts="contacts" :initial="editing ?? undefined" :error="formError" @submit="onSubmit" />
    </ModalDialog>
  </div>
  <p v-else>{{ t('app.loading') }}</p>
</template>
