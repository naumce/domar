<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { BankStatement, InvoiceRow, StatementLine } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import AppButton from '@/components/ui/AppButton.vue';
import { formatMoney } from '@/utils/money';

const props = defineProps<{ buildingId: string }>();
const { t } = useI18n();
const statements = ref<BankStatement[]>([]); const selected = ref<string | null>(null); const lines = ref<StatementLine[]>([]);
const openInvoices = ref<InvoiceRow[]>([]); const warnings = ref<string[]>([]); const error = ref(''); const busy = ref(false);
const file = ref<File | null>(null); const chosen = ref<Record<string, string>>({});
async function loadList() { statements.value = (await api.get<{ rows: BankStatement[] }>(`/api/buildings/${props.buildingId}/statements`)).rows; }
async function loadOpen() {
  const res = await api.get<{ rows: InvoiceRow[] }>('/api/invoices', { buildingId: props.buildingId, pageSize: 200 });
  openInvoices.value = res.rows.filter((r) => r.status === 'published' || r.status === 'partially_paid');
}
async function select(id: string) { selected.value = id; lines.value = (await api.get<{ lines: StatementLine[] }>(`/api/statements/${id}`)).lines; }
onMounted(async () => { try { await loadList(); await loadOpen().catch(() => {}); } catch { error.value = t('app.error'); } });
function onFile(e: Event) { file.value = (e.target as HTMLInputElement).files?.[0] ?? null; }
async function upload() {
  if (!file.value) return;
  busy.value = true; error.value = ''; warnings.value = [];
  try {
    const content = await file.value.text();
    const res = await api.post<BankStatement & { lines: StatementLine[]; warnings?: string[] }>(`/api/buildings/${props.buildingId}/statements`, { filename: file.value.name, content });
    warnings.value = res.warnings ?? [];
    await loadList(); await loadOpen(); await select(res.id); file.value = null;
  } catch (e) { const code = (e as { code?: string }).code; error.value = code === 'unknown_format' ? t('statements.unknownFormat') : t('app.error'); } finally { busy.value = false; }
}
async function act(line: StatementLine, action: 'confirm' | 'ignore' | 'unmatch') {
  error.value = '';
  try {
    const invoiceId = chosen.value[line.id] ?? line.suggestedInvoice?.id;
    if (action === 'confirm' && !invoiceId) { error.value = t('statements.chooseInvoice'); return; }
    await api.post(`/api/statement-lines/${line.id}/${action}`, action === 'confirm' ? { invoiceId } : {});
    if (selected.value) await select(selected.value);
    if (action === 'confirm' && invoiceId) {
      const inv = openInvoices.value.find((i) => i.id === invoiceId);
      if (inv) {
        inv.outstandingMinor -= line.amountMinor;
        if (inv.outstandingMinor <= 0) openInvoices.value = openInvoices.value.filter((i) => i.id !== invoiceId);
        else inv.status = 'partially_paid';
      }
      delete chosen.value[line.id];
    } else if (action === 'unmatch') {
      await loadOpen().catch(() => {});
    }
  } catch { error.value = t('app.error'); }
}
</script>
<template>
  <div class="mb-4 flex items-end gap-3 rounded-xl bg-white p-4 shadow-sm">
    <label class="text-sm"><span class="mb-1 block font-medium text-slate-700">{{ t('statements.file') }}</span><input type="file" accept=".sta,.txt,.csv,.mt940" data-test="stmt-file" @change="onFile" /></label>
    <AppButton :loading="busy" data-test="stmt-upload" @click="upload">{{ t('statements.upload') }}</AppButton>
  </div>
  <p v-if="error" class="mb-2 text-sm text-red-600" data-test="error">{{ error }}</p>
  <ul v-if="warnings.length" class="mb-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900"><li class="font-medium">{{ t('statements.warnings') }}</li><li v-for="(w, i) in warnings" :key="i">{{ w }}</li></ul>
  <div class="grid grid-cols-3 gap-4">
    <div class="rounded-xl bg-white shadow-sm">
      <button v-for="s in statements" :key="s.id" class="block w-full border-b border-slate-100 px-4 py-2 text-left text-sm hover:bg-slate-50" :class="{ 'bg-emerald-50': s.id === selected }" data-test="stmt-row" @click="select(s.id)">
        <div class="font-medium">{{ s.filename }}</div>
        <div class="text-xs text-slate-500">{{ new Date(s.importedAt).toLocaleDateString('mk-MK') }} · {{ t('statements.lines') }} {{ s.lineCount }} · {{ t('statements.matched') }} {{ s.matchedCount }} · {{ t('statements.skipped') }} {{ s.skippedCount }}</div>
      </button>
      <p v-if="!statements.length" class="p-4 text-sm text-slate-500">{{ t('app.empty') }}</p>
    </div>
    <div class="col-span-2">
      <DataTable :columns="[{ key: 'bookedAt', label: t('payments.paidAt') }, { key: 'amountMinor', label: t('payments.amount') }, { key: 'reference', label: t('payments.reference') }, { key: 'counterparty', label: t('statements.counterparty') }, { key: 'matchStatus', label: t('billing.status') }, { key: 'suggestedInvoice', label: t('statements.suggested') }]" :rows="lines">
        <template #cell-bookedAt="{ row }">{{ new Date(row.bookedAt).toLocaleDateString('mk-MK') }}</template>
        <template #cell-amountMinor="{ row }"><span :class="{ 'text-red-600': row.amountMinor < 0 }">{{ formatMoney(row.amountMinor) }}</span></template>
        <template #cell-matchStatus="{ row }">{{ t(`statements.status.${row.matchStatus}`) }}<span v-if="row.confidence" class="ml-1 text-xs text-slate-500">({{ row.confidence }})</span></template>
        <template #cell-suggestedInvoice="{ row }">
          <RouterLink v-if="row.suggestedInvoice" :to="`/app/invoices/${row.suggestedInvoice.id}`" class="text-emerald-700 underline">{{ row.suggestedInvoice.number }}</RouterLink>
          <select v-else-if="row.matchStatus === 'unmatched' && row.amountMinor > 0" v-model="chosen[row.id]" class="rounded-md border border-slate-300 px-2 py-1 text-sm" data-test="line-invoice">
            <option :value="undefined">{{ t('statements.chooseInvoice') }}</option>
            <option v-for="inv in openInvoices" :key="inv.id" :value="inv.id">{{ inv.number }} · {{ inv.contact.lastName }} · {{ formatMoney(inv.outstandingMinor) }}</option>
          </select>
        </template>
        <template #actions="{ row }">
          <template v-if="(row.matchStatus === 'unmatched' || row.matchStatus === 'suggested') && row.amountMinor > 0">
            <AppButton data-test="line-confirm" @click="act(row, 'confirm')">{{ t('statements.confirm') }}</AppButton>
            <AppButton variant="secondary" class="ml-2" data-test="line-ignore" @click="act(row, 'ignore')">{{ t('statements.ignore') }}</AppButton>
          </template>
          <AppButton v-else-if="row.matchStatus === 'matched' || row.matchStatus === 'ignored'" variant="secondary" data-test="line-unmatch" @click="act(row, 'unmatch')">{{ t('statements.unmatch') }}</AppButton>
        </template>
      </DataTable>
    </div>
  </div>
</template>
