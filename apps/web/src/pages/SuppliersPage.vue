<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Supplier } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import ModalDialog from '@/components/ModalDialog.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import { swallow, useResource } from '@/composables/useResource';

const { t, te } = useI18n();
const suppliers = useResource<Supplier>('/api/suppliers');
const open = ref(false);
const error = ref('');
const form = ref({ name: '', companyNumber: '', vatNumber: '', email: '', phone: '', iban: '' });
onMounted(() => swallow(suppliers.load({ includeInactive: 'true' })));

function openNew() { form.value = { name: '', companyNumber: '', vatNumber: '', email: '', phone: '', iban: '' }; error.value = ''; open.value = true; }
async function submit() {
  error.value = '';
  try {
    await suppliers.create({
      name: form.value.name, companyNumber: form.value.companyNumber || null, vatNumber: form.value.vatNumber || null,
      email: form.value.email || null, phone: form.value.phone || null, iban: form.value.iban || null,
    });
    open.value = false;
  } catch (e) {
    const code = (e as { code?: string }).code ?? 'generic';
    error.value = te(`suppliers.errors.${code}`) ? t(`suppliers.errors.${code}`) : t('app.error');
  }
}
async function remove(id: string) {
  error.value = '';
  try { await suppliers.remove(id); } catch (e) {
    const code = (e as { code?: string }).code ?? 'generic';
    error.value = te(`suppliers.errors.${code}`) ? t(`suppliers.errors.${code}`) : t('app.error');
  }
}
</script>
<template>
  <div>
    <div class="mb-3 flex items-center justify-between"><h1 class="text-2xl font-semibold">{{ t('suppliers.title') }}</h1><AppButton data-test="add-supplier" @click="openNew">{{ t('suppliers.add') }}</AppButton></div>
    <p v-if="error" class="mb-2 text-sm text-red-600" data-test="page-error">{{ error }}</p>
    <DataTable :columns="[{ key: 'name', label: t('suppliers.name') }, { key: 'companyNumber', label: t('contacts.companyNumber') }, { key: 'vatNumber', label: t('contacts.vatNumber') }, { key: 'email', label: t('auth.email') }, { key: 'phone', label: t('contacts.phone') }, { key: 'iban', label: t('suppliers.iban') }]" :rows="suppliers.rows.value">
      <template #actions="{ row }"><AppButton variant="danger" @click="remove(row.id)">{{ t('app.delete') }}</AppButton></template>
    </DataTable>
    <ModalDialog :open="open" :title="t('suppliers.add')" @close="open = false">
      <form class="grid grid-cols-2 gap-3" @submit.prevent="submit">
        <AppInput v-model="form.name" :label="t('suppliers.name')" data-test="supplier-name" class="col-span-2" />
        <AppInput v-model="form.companyNumber" :label="t('contacts.companyNumber')" />
        <AppInput v-model="form.vatNumber" :label="t('contacts.vatNumber')" />
        <AppInput v-model="form.email" :label="t('auth.email')" />
        <AppInput v-model="form.phone" :label="t('contacts.phone')" />
        <AppInput v-model="form.iban" :label="t('suppliers.iban')" class="col-span-2" />
        <div class="col-span-2 flex justify-end"><AppButton type="button" data-test="supplier-submit" @click="submit">{{ t('app.create') }}</AppButton></div>
      </form>
    </ModalDialog>
  </div>
</template>
