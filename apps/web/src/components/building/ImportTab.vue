<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { UnitImportResult } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import AppButton from '@/components/ui/AppButton.vue';
import { formatMoney } from '@/utils/money';

const TEMPLATE = 'број;кат;тип;површина;удел;име;презиме;е-пошта;телефон;почетно салдо\n'
  + '1;1;стан;54,5;0,085;Марко;Марков;marko@example.mk;070111222;1.200,00\n'
  + '2;1;стан;62;0,095;Ана;Бошковска;ana@example.mk;;0\n'
  + 'P-1;;паркинг;;;;;;;\n';

const props = defineProps<{ buildingId: string }>();
const { t } = useI18n();
const url = `/api/buildings/${props.buildingId}/import/units`;
const file = ref<File | null>(null);
const fileName = ref('');
const mode = ref<'fail' | 'skip'>('fail');
const result = ref<UnitImportResult | null>(null);
const done = ref(false);
const error = ref('');
const busy = ref(false);
const force = ref(false);

function readText(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(f);
  });
}

function onFile(e: Event) {
  file.value = (e.target as HTMLInputElement).files?.[0] ?? null;
  fileName.value = file.value?.name ?? '';
  result.value = null; done.value = false; error.value = ''; force.value = false;
}

function fail(e: unknown) {
  const code = (e as { code?: string }).code;
  error.value = code === 'label_conflict' ? t('imports.failure.label_conflict')
    : code === 'period_published' ? t('imports.failure.period_published')
    : t('app.error');
}

async function buildBody(dryRun: boolean): Promise<{ content: string; mode: 'fail' | 'skip'; dryRun?: true; force?: true }> {
  const content = await readText(file.value as File);
  const body: { content: string; mode: 'fail' | 'skip'; dryRun?: true; force?: true } = { content, mode: mode.value };
  if (dryRun) body.dryRun = true;
  if (force.value) body.force = true;
  return body;
}

async function preview() {
  if (!file.value) { error.value = t('imports.chooseFile'); return; }
  busy.value = true; error.value = ''; done.value = false;
  try {
    result.value = await api.post<UnitImportResult>(url, await buildBody(true));
  } catch (e) { fail(e); } finally { busy.value = false; }
}

async function commit() {
  if (!file.value) { error.value = t('imports.chooseFile'); return; }
  busy.value = true; error.value = '';
  try {
    result.value = await api.post<UnitImportResult>(url, await buildBody(false));
    done.value = true;
  } catch (e) { fail(e); } finally { busy.value = false; }
}

function downloadTemplate() {
  const blob = new Blob([`﻿${TEMPLATE}`], { type: 'text/csv;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href; a.download = 'domar-units-template.csv';
  a.click();
  URL.revokeObjectURL(href);
}
</script>
<template>
  <div class="mb-4 flex flex-wrap items-end gap-3 rounded-xl bg-white p-4 shadow-sm">
    <label class="text-sm">
      <span class="mb-1 block font-medium text-slate-700">{{ t('imports.file') }}</span>
      <input type="file" accept=".csv,text/csv" data-test="import-file" @change="onFile" />
    </label>
    <label class="text-sm">
      <span class="mb-1 block font-medium text-slate-700">{{ t('imports.mode') }}</span>
      <select v-model="mode" data-test="import-mode" class="rounded-md border border-slate-300 bg-white px-3 py-2">
        <option value="fail">{{ t('imports.modeFail') }}</option>
        <option value="skip">{{ t('imports.modeSkip') }}</option>
      </select>
    </label>
    <AppButton variant="secondary" :loading="busy" data-test="import-preview" @click="preview">{{ t('imports.preview') }}</AppButton>
    <AppButton :loading="busy" :disabled="busy || (result?.blocked === 'period_published' && !force)" data-test="import-commit" @click="commit">{{ t('imports.commit') }}</AppButton>
    <AppButton variant="secondary" data-test="import-template" @click="downloadTemplate">{{ t('imports.template') }}</AppButton>
  </div>
  <p v-if="error" class="mb-2 text-sm text-red-600" data-test="import-error">{{ error }}</p>
  <div v-if="result">
    <p v-if="result.blocked === 'period_published'" class="mb-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{{ t('import.errors.period_published') }}</p>
    <label v-if="result.hasPublishedPeriod" class="mb-3 block text-sm"><input v-model="force" type="checkbox" data-test="import-force" /> {{ t('import.force') }}</label>
    <div class="mb-3 grid grid-cols-4 gap-3">
      <div class="rounded-xl bg-white p-3 shadow-sm"><div class="text-sm text-slate-500">{{ t('imports.counts.units') }}</div><div class="text-xl font-semibold" data-test="import-count-units">{{ result.counts.units }}</div></div>
      <div class="rounded-xl bg-white p-3 shadow-sm"><div class="text-sm text-slate-500">{{ t('imports.counts.contacts') }}</div><div class="text-xl font-semibold" data-test="import-count-contacts">{{ result.counts.newContacts }} / {{ result.counts.existingContacts }}</div></div>
      <div class="rounded-xl bg-white p-3 shadow-sm"><div class="text-sm text-slate-500">{{ t('imports.counts.balances') }}</div><div class="text-xl font-semibold" data-test="import-count-balances">{{ result.counts.openingBalances }}</div></div>
      <div class="rounded-xl bg-white p-3 shadow-sm"><div class="text-sm text-slate-500">{{ t('imports.counts.conflicts') }}</div><div class="text-xl font-semibold" data-test="import-count-conflicts">{{ result.counts.conflicts }}</div></div>
    </div>
    <p v-if="done" class="mb-3 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-900" data-test="import-done">{{ t('imports.done', { units: result.counts.units, contacts: result.counts.newContacts, balances: result.counts.openingBalances }) }}</p>
    <ul v-if="result.errors.length" class="mb-3 rounded-xl bg-red-50 p-3 text-sm text-red-900">
      <li class="font-medium">{{ t('imports.errors') }}</li>
      <li v-for="e in result.errors" :key="e.line" data-test="import-error-line">{{ t('imports.line') }} {{ e.line }}: {{ e.message }}</li>
    </ul>
    <p v-if="result.conflicts.length" class="mb-3 text-sm text-amber-800">{{ t('imports.conflicts') }}: {{ result.conflicts.join(', ') }}</p>
    <DataTable
      :columns="[{ key: 'line', label: t('imports.line') }, { key: 'label', label: t('units.label') }, { key: 'kind', label: t('units.kind') }, { key: 'areaM2', label: t('units.areaM2') }, { key: 'owner', label: t('units.owner') }, { key: 'openingBalanceMinor', label: t('openingBalances.title') }]"
      :rows="result.rows.map((r) => ({ ...r, id: String(r.line) }))">
      <template #cell-kind="{ row }">{{ t(`units.kinds.${row.kind}`) }}</template>
      <template #cell-owner="{ row }">{{ [row.ownerFirstName, row.ownerLastName].filter(Boolean).join(' ') }}</template>
      <template #cell-openingBalanceMinor="{ row }">{{ formatMoney(row.openingBalanceMinor) }}</template>
    </DataTable>
  </div>
</template>
