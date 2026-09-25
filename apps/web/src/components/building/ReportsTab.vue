<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, API_BASE } from '@/api/client';
import type { AnnualReportData, ReportIssueResult, ReportList, ReportRow } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import { formatMoney, percentFromBp, toMinor } from '@/utils/money';

const props = defineProps<{ buildingId: string }>();
const { t, te } = useI18n();

const THIS_YEAR = new Date().getFullYear();
/** The current year and the four before it: nobody files an Art. 31 report for 2011. */
const YEARS = [0, 1, 2, 3, 4].map((n) => String(THIS_YEAR - n));
const todayIso = () => new Date().toISOString().slice(0, 10);

const rows = ref<ReportRow[]>([]);
const year = ref(String(THIS_YEAR));
const preview = ref<AnnualReportData | null>(null);
const handover = ref({ asOf: todayIso(), regular: '', reserve: '', note: '' });
const error = ref('');
const busy = ref(false);
const loaded = ref(false);

// DataTable keys its rows by `id`; a filed report is keyed by the event that filed it.
const tableRows = computed(() => rows.value.map((r) => ({ ...r, id: r.eventId })));
const downloadUrl = (id: string) => `${API_BASE}/api/documents/${id}/download`;
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('mk-MK');
const money = (key: string) => formatMoney(Number(preview.value?.fields[key] ?? 0));

function show(e: unknown) {
  const code = (e as { code?: string }).code ?? 'generic';
  error.value = te(`reports.errors.${code}`) ? t(`reports.errors.${code}`) : t('app.error');
}

async function load() {
  rows.value = (await api.get<ReportList>(`/api/buildings/${props.buildingId}/reports`)).rows;
}

async function loadPreview() {
  error.value = '';
  try {
    preview.value = await api.get<AnnualReportData>(`/api/buildings/${props.buildingId}/reports/annual/preview`, { year: year.value });
  } catch (e) {
    preview.value = null;
    show(e);
  }
}

// Fired together, not sequentially: the list and the preview are two independent reads, and a
// test (or a slow list) must not delay the preview's own fetch behind it.
onMounted(async () => {
  await Promise.all([load().catch((e) => show(e)), loadPreview()]);
  loaded.value = true;
});
// A watcher, not `@change` on the component: AppSelect emits no change event of its own.
watch(year, () => { void loadPreview(); });

async function issueAnnual() {
  error.value = '';
  busy.value = true;
  try {
    await api.post<ReportIssueResult>(`/api/buildings/${props.buildingId}/reports/annual`, { year: Number(year.value) });
    await load();
    await loadPreview();
  } catch (e) { show(e); } finally { busy.value = false; }
}

async function issueHandover() {
  error.value = '';
  // Both balances are typed in the local format and must parse; an unparsed one would silently
  // become a zero and print a shortfall the building does not have.
  const regularMinor = toMinor(handover.value.regular);
  const reserveMinor = toMinor(handover.value.reserve);
  if (regularMinor === null || reserveMinor === null || !handover.value.asOf) {
    error.value = t('reports.errors.validation');
    return;
  }
  busy.value = true;
  try {
    await api.post<ReportIssueResult>(`/api/buildings/${props.buildingId}/reports/handover`, {
      asOf: handover.value.asOf,
      bankBalances: { regularMinor, reserveMinor },
      note: handover.value.note.trim() || null,
    });
    handover.value = { asOf: todayIso(), regular: '', reserve: '', note: '' };
    await load();
  } catch (e) { show(e); } finally { busy.value = false; }
}
</script>
<template>
  <div v-if="loaded" class="space-y-4">
    <section class="rounded-xl bg-white p-4 shadow-sm">
      <div class="mb-3 flex items-end gap-3">
        <AppSelect v-model="year" :label="t('reports.year')" :options="YEARS.map((y) => ({ value: y, label: y }))" data-test="report-year" />
        <AppButton type="button" :loading="busy" data-test="report-issue-annual" @click="issueAnnual">{{ t('reports.issueAnnual') }}</AppButton>
      </div>
      <div v-if="preview" class="grid grid-cols-4 gap-3 text-sm">
        <div class="rounded-lg bg-slate-50 p-3" data-test="report-kpi-billed"><div class="text-slate-500">{{ t('reports.billed') }}</div><strong>{{ money('billedMinor') }}</strong></div>
        <div class="rounded-lg bg-slate-50 p-3" data-test="report-kpi-collected"><div class="text-slate-500">{{ t('reports.collected') }}</div><strong>{{ money('collectedMinor') }}</strong></div>
        <div class="rounded-lg bg-slate-50 p-3" data-test="report-kpi-rate"><div class="text-slate-500">{{ t('reports.rate') }}</div><strong>{{ percentFromBp(Number(preview.fields.collectionRateBp ?? 0)) }}</strong></div>
        <div class="rounded-lg bg-slate-50 p-3" data-test="report-kpi-debt"><div class="text-slate-500">{{ t('reports.totalDebt') }}</div><strong>{{ money('totalDebtMinor') }}</strong> <span class="text-slate-500">({{ preview.fields.debtorsCount }})</span></div>
        <div class="rounded-lg bg-slate-50 p-3" data-test="report-kpi-regular"><div class="text-slate-500">{{ t('reports.regularClosing') }}</div><strong>{{ money('regularClosingMinor') }}</strong></div>
        <div class="rounded-lg bg-slate-50 p-3" data-test="report-kpi-reserve"><div class="text-slate-500">{{ t('reports.reserveClosing') }}</div><strong>{{ money('reserveClosingMinor') }}</strong></div>
        <div class="rounded-lg bg-slate-50 p-3" data-test="report-kpi-expenses"><div class="text-slate-500">{{ t('reports.expenses') }}</div><strong>{{ money('expensesMinor') }}</strong></div>
        <div class="rounded-lg bg-slate-50 p-3" data-test="report-kpi-works"><div class="text-slate-500">{{ t('reports.works') }}</div><strong>{{ money('worksMinor') }}</strong> <span class="text-slate-500">({{ preview.fields.worksCount }})</span></div>
      </div>
    </section>

    <section class="rounded-xl bg-white p-4 shadow-sm">
      <h3 class="mb-1 font-semibold">{{ t('reports.handover') }}</h3>
      <p class="mb-3 text-sm text-slate-600">{{ t('reports.handoverIntro') }}</p>
      <form class="grid grid-cols-5 items-end gap-3" @submit.prevent="issueHandover">
        <AppInput v-model="handover.asOf" :label="t('reports.asOf')" type="date" data-test="handover-as-of" />
        <AppInput v-model="handover.regular" :label="t('reports.bankRegular')" data-test="handover-bank-regular" placeholder="0,00" />
        <AppInput v-model="handover.reserve" :label="t('reports.bankReserve')" data-test="handover-bank-reserve" placeholder="0,00" />
        <AppInput v-model="handover.note" :label="t('reports.note')" data-test="handover-note" />
        <AppButton type="button" :loading="busy" data-test="report-issue-handover" @click="issueHandover">{{ t('reports.issueHandover') }}</AppButton>
      </form>
    </section>

    <p v-if="error" class="text-sm text-red-600" data-test="report-error">{{ error }}</p>

    <h3 class="font-semibold">{{ t('reports.issued') }}</h3>
    <DataTable
      :columns="[{ key: 'kind', label: t('reports.kind') }, { key: 'title', label: t('reports.reportTitle') }, { key: 'occurredAt', label: t('reports.date') }]"
      :rows="tableRows"
    >
      <template #cell-kind="{ row }">{{ t(`reports.kinds.${row.kind}`) }}</template>
      <template #cell-occurredAt="{ row }">{{ fmtDate(row.occurredAt) }}</template>
      <template #actions="{ row }">
        <a v-if="row.documentId" class="mr-2 text-sm text-emerald-700 underline" :href="downloadUrl(row.documentId)" target="_blank" rel="noopener" data-test="report-download">{{ t('reports.download') }}</a>
        <a v-if="row.exportDocumentId" class="text-sm text-emerald-700 underline" :href="downloadUrl(row.exportDocumentId)" target="_blank" rel="noopener" data-test="report-export">{{ t('reports.export') }}</a>
      </template>
    </DataTable>
  </div>
  <p v-else>{{ t('app.loading') }}</p>
</template>
