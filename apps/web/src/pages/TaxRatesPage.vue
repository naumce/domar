<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TaxRate } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import ModalDialog from '@/components/ModalDialog.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import { swallow, useResource } from '@/composables/useResource';

const { t } = useI18n();
const res = useResource<TaxRate>('/api/tax-rates');
const open = ref(false); const name = ref(''); const rate = ref<string>('18');
onMounted(() => res.load());
async function submit() {
  await res.create({ name: name.value, rateBp: Math.round(Number(rate.value) * 100) });
  open.value = false; name.value = ''; rate.value = '18';
}
</script>
<template>
  <div class="mb-4 flex items-center justify-between"><h1 class="text-2xl font-semibold">{{ t('taxRates.title') }}</h1><AppButton data-test="add" @click="open = true">{{ t('taxRates.add') }}</AppButton></div>
  <p v-if="res.error.value" class="mb-2 text-sm text-red-600" data-test="page-error">{{ t('app.error') }}</p>
  <DataTable :columns="[{ key: 'name', label: t('taxRates.name') }, { key: 'rateBp', label: t('taxRates.rate') }, { key: 'isDefault', label: t('taxRates.isDefault') }]" :rows="res.rows.value">
    <template #cell-rateBp="{ row }">{{ (Number(row.rateBp) / 100).toFixed(2) }}</template>
    <template #cell-isDefault="{ row }">{{ row.isDefault ? t('app.yes') : '' }}</template>
    <template #actions="{ row }">
      <AppButton v-if="!row.isDefault" variant="secondary" @click="swallow(res.update(row.id, { isDefault: true }))">{{ t('taxRates.makeDefault') }}</AppButton>
      <AppButton v-if="!row.isDefault" variant="danger" class="ml-2" @click="swallow(res.remove(row.id))">{{ t('app.delete') }}</AppButton>
    </template>
  </DataTable>
  <ModalDialog :open="open" :title="t('taxRates.add')" @close="open = false">
    <form class="space-y-3" @submit.prevent="submit">
      <AppInput v-model="name" :label="t('taxRates.name')" data-test="name" />
      <AppInput v-model="rate" :label="t('taxRates.rate')" type="number" step="0.01" data-test="rate" />
      <div class="flex justify-end gap-2"><AppButton variant="secondary" @click="open = false">{{ t('app.cancel') }}</AppButton><AppButton type="submit" data-test="submit">{{ t('app.create') }}</AppButton></div>
    </form>
  </ModalDialog>
</template>
