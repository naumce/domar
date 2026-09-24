<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, API_BASE } from '@/api/client';
import type { DocumentKind, DocumentMeta } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';

const props = defineProps<{ buildingId: string }>();
const { t, te } = useI18n();
const KINDS: DocumentKind[] = ['contract', 'minutes', 'report', 'invoice_supplier', 'photo', 'other'];
const rows = ref<DocumentMeta[]>([]);
const filter = ref<string | null>('');
const form = ref<{ kind: DocumentKind; title: string }>({ kind: 'other', title: '' });
const file = ref<File | null>(null);
const uploading = ref(false);
const error = ref('');

const downloadUrl = (id: string) => `${API_BASE}/api/documents/${id}/download`;
const fmtSize = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`;
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('mk-MK');

async function load() {
  rows.value = (await api.get<{ rows: DocumentMeta[] }>(`/api/buildings/${props.buildingId}/documents`, filter.value ? { kind: filter.value } : undefined)).rows;
}
onMounted(load);
// A watcher, not `@change` on the component: AppSelect emits no change event of its own.
watch(filter, () => { void load(); });

function onFile(e: Event) {
  file.value = (e.target as HTMLInputElement).files?.[0] ?? null;
}

function show(e: unknown) {
  const code = (e as { code?: string }).code ?? 'generic';
  error.value = te(`documents.errors.${code}`) ? t(`documents.errors.${code}`) : t('app.error');
}

async function upload() {
  if (!file.value) { error.value = t('documents.errors.file_required'); return; }
  uploading.value = true; error.value = '';
  try {
    const fd = new FormData();
    // Order matters: busboy only exposes the fields that precede the file part.
    fd.append('kind', form.value.kind);
    fd.append('title', form.value.title.trim() || file.value.name);
    fd.append('file', file.value, file.value.name);
    await api.upload<DocumentMeta>(`/api/buildings/${props.buildingId}/documents`, fd);
    form.value = { kind: 'other', title: '' };
    file.value = null;
    await load();
  } catch (e) { show(e); } finally { uploading.value = false; }
}

async function remove(id: string) {
  if (!window.confirm(t('app.confirmDelete'))) return;
  error.value = '';
  try { await api.del(`/api/documents/${id}`); await load(); } catch (e) { show(e); }
}
</script>
<template>
  <div class="space-y-4">
    <form class="grid grid-cols-4 items-end gap-3 rounded-xl bg-white p-4 shadow-sm" @submit.prevent="upload">
      <AppSelect v-model="form.kind" :label="t('documents.kind')" :options="KINDS.map((k) => ({ value: k, label: t(`documents.kinds.${k}`) }))" data-test="doc-kind" />
      <AppInput v-model="form.title" :label="t('documents.docTitle')" data-test="doc-title" />
      <label class="block text-sm"><span class="mb-1 block font-medium text-slate-700">{{ t('documents.file') }}</span>
        <input type="file" class="w-full text-sm" data-test="doc-file" accept=".pdf,.png,.jpg,.jpeg,.docx,.xlsx,.csv,.txt" @change="onFile" /></label>
      <AppButton type="button" :loading="uploading" data-test="doc-upload" @click="upload">{{ t('documents.upload') }}</AppButton>
    </form>
    <p v-if="error" class="text-sm text-red-600" data-test="doc-error">{{ error }}</p>
    <AppSelect v-model="filter" :label="t('documents.filter')" :options="[{ value: '', label: t('documents.allKinds') }, ...KINDS.map((k) => ({ value: k, label: t(`documents.kinds.${k}`) }))]" data-test="doc-filter" />
    <DataTable :columns="[{ key: 'title', label: t('documents.docTitle') }, { key: 'kind', label: t('documents.kind') }, { key: 'fileName', label: t('documents.file') }, { key: 'sizeBytes', label: t('documents.size') }, { key: 'createdAt', label: t('documents.uploadedAt') }]" :rows="rows">
      <template #cell-kind="{ row }">{{ t(`documents.kinds.${row.kind}`) }}</template>
      <template #cell-sizeBytes="{ row }">{{ fmtSize(row.sizeBytes) }}</template>
      <template #cell-createdAt="{ row }">{{ fmtDate(row.createdAt) }}</template>
      <template #actions="{ row }">
        <a class="mr-2 text-sm text-emerald-700 underline" :href="downloadUrl(row.id)" data-test="doc-download">{{ t('documents.download') }}</a>
        <AppButton variant="danger" data-test="doc-delete" @click="remove(row.id)">{{ t('app.delete') }}</AppButton>
      </template>
    </DataTable>
  </div>
</template>
