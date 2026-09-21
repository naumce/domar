<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Contact } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import ModalDialog from '@/components/ModalDialog.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import { useResource } from '@/composables/useResource';

const { t } = useI18n();
const res = useResource<Contact>('/api/contacts');
const search = ref(''); const open = ref(false);
const blank = () => ({ kind: 'person' as 'person' | 'company', firstName: '', lastName: '', companyNumber: '', vatNumber: '', email: '', phone: '', address: '', notes: '' });
const form = ref(blank());
onMounted(() => res.load());
function doSearch() { void res.load({ search: search.value || undefined }); }
async function submit() {
  const f = form.value;
  await res.create({ kind: f.kind, firstName: f.firstName, lastName: f.lastName, companyNumber: f.companyNumber || null, vatNumber: f.vatNumber || null, email: f.email || null, phone: f.phone || null, address: f.address || null, notes: f.notes || null });
  open.value = false; form.value = blank();
}
</script>
<template>
  <div class="mb-4 flex items-center justify-between"><h1 class="text-2xl font-semibold">{{ t('contacts.title') }} <span class="text-base text-slate-500">{{ res.total.value }}</span></h1><AppButton data-test="add" @click="open = true">{{ t('contacts.add') }}</AppButton></div>
  <form class="mb-3 flex gap-2" @submit.prevent="doSearch"><input v-model="search" :placeholder="t('app.search')" class="rounded-md border border-slate-300 px-3 py-2 text-sm" data-test="search" /><AppButton type="submit" variant="secondary">{{ t('app.search') }}</AppButton></form>
  <DataTable :columns="[{ key: 'lastName', label: t('auth.lastName') }, { key: 'firstName', label: t('auth.firstName') }, { key: 'email', label: t('auth.email') }, { key: 'phone', label: t('contacts.phone') }]" :rows="res.rows.value">
    <template #actions="{ row }"><AppButton variant="danger" @click="res.remove(String(row.id))">{{ t('app.delete') }}</AppButton></template>
  </DataTable>
  <ModalDialog :open="open" :title="t('contacts.add')" @close="open = false">
    <form class="grid grid-cols-2 gap-3" @submit.prevent="submit">
      <AppSelect v-model="form.kind" :label="t('contacts.kind')" :options="[{ value: 'person', label: t('contacts.person') }, { value: 'company', label: t('contacts.company') }]" data-test="kind" class="col-span-2" />
      <AppInput v-if="form.kind === 'person'" v-model="form.firstName" :label="t('auth.firstName')" data-test="firstName" />
      <AppInput v-model="form.lastName" :label="form.kind === 'company' ? t('auth.orgName') : t('auth.lastName')" data-test="lastName" :class="{ 'col-span-2': form.kind === 'company' }" />
      <AppInput v-if="form.kind === 'company'" v-model="form.companyNumber" :label="t('contacts.companyNumber')" data-test="companyNumber" />
      <AppInput v-if="form.kind === 'company'" v-model="form.vatNumber" :label="t('contacts.vatNumber')" />
      <AppInput v-model="form.email" :label="t('auth.email')" type="email" data-test="email" />
      <AppInput v-model="form.phone" :label="t('contacts.phone')" />
      <AppInput v-model="form.address" :label="t('contacts.address')" class="col-span-2" />
      <p v-if="res.error.value" class="col-span-2 text-sm text-red-600">{{ t('auth.errors.validation') }}</p>
      <div class="col-span-2 flex justify-end gap-2"><AppButton variant="secondary" @click="open = false">{{ t('app.cancel') }}</AppButton><AppButton type="submit" data-test="submit">{{ t('app.create') }}</AppButton></div>
    </form>
  </ModalDialog>
</template>
