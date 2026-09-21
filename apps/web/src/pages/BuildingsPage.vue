<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { Building, Contact } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import ModalDialog from '@/components/ModalDialog.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import { useResource } from '@/composables/useResource';

const { t } = useI18n();
const res = useResource<Building>('/api/buildings');
const contacts = ref<Contact[]>([]);
const open = ref(false);
const blank = () => ({ name: '', address: '', city: '', postalCode: '', representativeContactId: null as string | null, shareBasis: 'area' as Building['shareBasis'] });
const form = ref(blank());
onMounted(async () => { await res.load(); contacts.value = (await api.get<{ rows: Contact[] }>('/api/contacts', { pageSize: 200 })).rows; });
async function submit() { await res.create(form.value); open.value = false; form.value = blank(); }
const shareOptions = (['area', 'equal', 'custom'] as const).map((v) => ({ value: v, label: t(`buildings.shareBasisOptions.${v}`) }));
</script>
<template>
  <div class="mb-4 flex items-center justify-between"><h1 class="text-2xl font-semibold">{{ t('buildings.title') }}</h1><AppButton data-test="add" @click="open = true">{{ t('buildings.add') }}</AppButton></div>
  <DataTable :columns="[{ key: 'name', label: t('buildings.name') }, { key: 'address', label: t('buildings.address') }, { key: 'city', label: t('buildings.city') }, { key: 'unitCount', label: t('buildings.unitCount') }]" :rows="res.rows.value">
    <template #cell-name="{ row }"><RouterLink :to="`/app/buildings/${row.id}`" class="text-emerald-700 underline" data-test="building-link">{{ row.name }}</RouterLink></template>
    <template #actions="{ row }"><AppButton variant="danger" @click="res.remove(String(row.id))">{{ t('app.delete') }}</AppButton></template>
  </DataTable>
  <ModalDialog :open="open" :title="t('buildings.add')" @close="open = false">
    <form class="grid grid-cols-2 gap-3" @submit.prevent="submit">
      <AppInput v-model="form.name" :label="t('buildings.name')" class="col-span-2" data-test="name" />
      <AppInput v-model="form.address" :label="t('buildings.address')" class="col-span-2" data-test="address" />
      <AppInput v-model="form.city" :label="t('buildings.city')" data-test="city" />
      <AppInput v-model="form.postalCode" :label="t('buildings.postalCode')" />
      <AppSelect v-model="form.representativeContactId" :label="t('buildings.representative')" :options="[{ value: null, label: t('buildings.none') }, ...contacts.map((c) => ({ value: c.id, label: `${c.firstName} ${c.lastName}`.trim() }))]" />
      <AppSelect v-model="form.shareBasis" :label="t('buildings.shareBasis')" :options="shareOptions" />
      <div class="col-span-2 flex justify-end gap-2"><AppButton variant="secondary" @click="open = false">{{ t('app.cancel') }}</AppButton><AppButton type="submit" data-test="submit">{{ t('app.create') }}</AppButton></div>
    </form>
  </ModalDialog>
</template>
