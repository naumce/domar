<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { CANONICAL_HEADER, emptyImportRow, IMPORT_FIELDS, type ImportField, matchImportHeader, rowsToCanonicalCsv } from '@domar/domain';
import { api } from '@/api/client';
import type { UnitImportResult } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import AppButton from '@/components/ui/AppButton.vue';
import { formatMoney } from '@/utils/money';
import { loadMapping, readWorkbookRows, saveMapping, splitDelimitedRows } from '@/utils/spreadsheet';

const TEMPLATE = `${CANONICAL_HEADER}\n`
  + '1;1;стан;54,5;0,085;Марко;Марков;marko@example.mk;070111222;1.200,00\n'
  + '2;1;стан;62;0,095;Ана;Бошковска;ana@example.mk;;0\n'
  + 'P-1;;паркинг;;;;;;;\n';

const props = defineProps<{ buildingId: string }>();
const emit = defineEmits<{ imported: [] }>();
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

const fields = IMPORT_FIELDS;
const mapOpen = ref(false);
const sourceHeaders = ref<string[]>([]);
const sourceRows = ref<string[][]>([]);
const mapping = ref<Record<ImportField, string>>(blankMapping());
const mappedCsv = ref<string | null>(null);
const mapError = ref('');

function blankMapping(): Record<ImportField, string> {
  return Object.fromEntries(IMPORT_FIELDS.map((f) => [f, ''])) as Record<ImportField, string>;
}

function readText(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(f);
  });
}

/** A commit is only allowed on a previewed file, so anything that changes what would be sent clears it. */
function resetPreview() {
  result.value = null; done.value = false; error.value = ''; force.value = false;
}

function onFile(e: Event) {
  file.value = (e.target as HTMLInputElement).files?.[0] ?? null;
  fileName.value = file.value?.name ?? '';
  mapOpen.value = false;
  mappedCsv.value = null;
  mapError.value = '';
  sourceHeaders.value = [];
  sourceRows.value = [];
  mapping.value = blankMapping();
  resetPreview();
  // A spreadsheet has no canonical header, so mapping is the only way in; a CSV keeps its old path.
  if (file.value && /\.xlsx?$/i.test(file.value.name)) void openMapping();
}

function fail(e: unknown) {
  const err = e as { code?: string; details?: { labels?: string[] } };
  if (err.code === 'label_conflict') {
    error.value = t('imports.failure.label_conflict', { labels: (err.details?.labels ?? []).join(', ') });
  } else if (err.code === 'period_published') {
    error.value = t('imports.failure.period_published');
  } else if (err.code === 'too_many_rows') {
    error.value = t('imports.failure.too_many_rows');
  } else {
    error.value = t('app.error');
  }
}

/** The mapped rows win when a mapping was applied; otherwise the file's own text is sent unchanged. */
async function buildBody(dryRun: boolean): Promise<{ content: string; mode: 'fail' | 'skip'; dryRun?: true; force?: true }> {
  const content = mappedCsv.value ?? await readText(file.value as File);
  const body: { content: string; mode: 'fail' | 'skip'; dryRun?: true; force?: true } = { content, mode: mode.value };
  if (dryRun) body.dryRun = true;
  if (force.value) body.force = true;
  return body;
}

async function openMapping() {
  if (!file.value) { error.value = t('imports.chooseFile'); return; }
  busy.value = true; error.value = ''; mapError.value = '';
  try {
    const rows = /\.xlsx?$/i.test(file.value.name)
      ? await readWorkbookRows(file.value)
      : splitDelimitedRows(await readText(file.value));
    sourceHeaders.value = rows[0] ?? [];
    sourceRows.value = rows.slice(1);
    mapping.value = prefill(sourceHeaders.value);
    mapOpen.value = true;
    mappedCsv.value = null;
    resetPreview();
  } catch {
    error.value = t('imports.map.readError');
  } finally {
    busy.value = false;
  }
}

/** Remembered mapping first (by header name), then the parser's own header aliases. */
function prefill(headers: string[]): Record<ImportField, string> {
  const remembered = loadMapping(headers);
  const next = blankMapping();
  for (const f of IMPORT_FIELDS) {
    const byName = remembered[f] ? headers.indexOf(remembered[f]!) : -1;
    if (byName >= 0) { next[f] = String(byName); continue; }
    const byAlias = headers.findIndex((h) => matchImportHeader(h) === f);
    if (byAlias >= 0) next[f] = String(byAlias);
  }
  return next;
}

function unmappedHeaders(): string[] {
  const used = new Set(Object.values(mapping.value).filter((v) => v !== ''));
  return sourceHeaders.value.filter((_, i) => !used.has(String(i)));
}

function applyMapping() {
  mapError.value = '';
  const seen = new Map<string, ImportField>();
  const clash: string[] = [];
  for (const f of IMPORT_FIELDS) {
    const v = mapping.value[f];
    if (v === '') continue;
    const first = seen.get(v);
    if (first) clash.push(`${t(`imports.map.fields.${first}`)} + ${t(`imports.map.fields.${f}`)}`);
    else seen.set(v, f);
  }
  if (clash.length > 0) { mapError.value = t('imports.map.duplicate', { fields: clash.join(', ') }); return; }
  if (mapping.value.label === '' || mapping.value.kind === '') { mapError.value = t('imports.map.required'); return; }

  mappedCsv.value = rowsToCanonicalCsv(sourceRows.value.map((cells) => {
    const row = emptyImportRow();
    for (const f of IMPORT_FIELDS) {
      const i = mapping.value[f];
      if (i !== '') row[f] = cells[Number(i)] ?? '';
    }
    return row;
  }));
  saveMapping(sourceHeaders.value, Object.fromEntries(
    IMPORT_FIELDS.filter((f) => mapping.value[f] !== '').map((f) => [f, sourceHeaders.value[Number(mapping.value[f])] ?? '']),
  ));
  mapOpen.value = false;
  resetPreview();
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
    emit('imported');
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
      <input type="file" accept=".csv,.xlsx,.xls,text/csv" data-test="import-file" @change="onFile" />
    </label>
    <label class="text-sm">
      <span class="mb-1 block font-medium text-slate-700">{{ t('imports.mode') }}</span>
      <select v-model="mode" data-test="import-mode" @change="resetPreview" class="rounded-md border border-slate-300 bg-white px-3 py-2">
        <option value="fail">{{ t('imports.modeFail') }}</option>
        <option value="skip">{{ t('imports.modeSkip') }}</option>
      </select>
    </label>
    <AppButton variant="secondary" :loading="busy" data-test="import-preview" @click="preview">{{ t('imports.preview') }}</AppButton>
    <AppButton :loading="busy" :disabled="busy || !result?.dryRun || (result.blocked === 'period_published' && !force)" data-test="import-commit" @click="commit">{{ t('imports.commit') }}</AppButton>
    <AppButton variant="secondary" data-test="import-template" @click="downloadTemplate">{{ t('imports.template') }}</AppButton>
    <AppButton variant="secondary" :disabled="!file" data-test="import-map-open" @click="openMapping">{{ t('imports.map.open') }}</AppButton>
  </div>
  <div v-if="mapOpen" class="mb-4 rounded-xl bg-white p-4 shadow-sm" data-test="import-map">
    <h3 class="mb-3 font-medium text-slate-700">{{ t('imports.map.title') }} — {{ fileName }}</h3>
    <div class="mb-3 grid grid-cols-2 gap-3 md:grid-cols-5">
      <label v-for="f in fields" :key="f" class="text-sm">
        <span class="mb-1 block text-slate-600">{{ t(`imports.map.fields.${f}`) }}</span>
        <select v-model="mapping[f]" :data-test="`import-map-${f}`" class="w-full rounded-md border border-slate-300 bg-white px-2 py-1">
          <option value="">{{ t('imports.map.none') }}</option>
          <option v-for="(h, i) in sourceHeaders" :key="i" :value="String(i)">{{ h }}</option>
        </select>
      </label>
    </div>
    <p v-if="unmappedHeaders().length" class="mb-3 text-sm text-slate-500" data-test="import-unmapped">
      {{ t('imports.map.unmapped') }}: {{ unmappedHeaders().join(', ') }}
    </p>
    <p v-if="mapError" class="mb-3 text-sm text-red-600" data-test="import-map-error">{{ mapError }}</p>
    <AppButton data-test="import-map-apply" @click="applyMapping">{{ t('imports.map.apply') }}</AppButton>
  </div>
  <p v-if="mappedCsv && !mapOpen" class="mb-2 text-sm text-emerald-800" data-test="import-map-ready">
    {{ t('imports.map.ready', { rows: sourceRows.length }) }}
  </p>
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
