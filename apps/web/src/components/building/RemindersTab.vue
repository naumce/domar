<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, API_BASE } from '@/api/client';
import type { Reminder } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import AppButton from '@/components/ui/AppButton.vue';
import { formatMoney } from '@/utils/money';

const props = defineProps<{ buildingId: string }>();
const { t, te } = useI18n();
const base = `/api/buildings/${props.buildingId}/reminders`;
const rows = ref<Reminder[]>([]);
const busy = ref(false);
const error = ref('');
const created = ref<number | null>(null);

async function load() { rows.value = (await api.get<{ rows: Reminder[] }>(base)).rows; }
onMounted(async () => { try { await load(); } catch { error.value = t('app.error'); } });

async function run() {
  busy.value = true; error.value = ''; created.value = null;
  try {
    const res = await api.post<{ rows: Reminder[] }>(`${base}/run`);
    created.value = res.rows.length;
    await load();
  } catch { error.value = t('app.error'); } finally { busy.value = false; }
}

async function markPrinted(id: string) {
  error.value = '';
  try { await api.post(`/api/reminders/${id}/printed`); await load(); } catch { error.value = t('app.error'); }
}

const date = (d: string | null) => (d ? new Date(d).toLocaleDateString('mk-MK') : '—');
const pdfHref = (id: string) => `${API_BASE}/api/reminders/${id}/pdf`;
// Known failure codes get a translation; anything the SMTP server said is shown as it came back.
const errorText = (e: string) => (te(`reminders.errors.${e}`) ? t(`reminders.errors.${e}`) : e);
</script>
<template>
  <div class="mb-4 flex items-center justify-between">
    <h2 class="text-lg font-semibold">{{ t('reminders.title') }} <span class="text-slate-500">{{ rows.length }}</span></h2>
    <AppButton :loading="busy" data-test="reminders-run" @click="run">{{ t('reminders.run') }}</AppButton>
  </div>
  <p v-if="error" class="mb-2 text-sm text-red-600" data-test="error">{{ error }}</p>
  <p v-if="created !== null" class="mb-2 text-sm text-emerald-700" data-test="reminders-created">{{ created > 0 ? t('reminders.created', { n: created }) : t('reminders.none') }}</p>
  <DataTable
    :columns="[{ key: 'contact', label: t('reminders.owner') }, { key: 'reason', label: t('reminders.reason') }, { key: 'invoiceNumbers', label: t('reminders.invoices') }, { key: 'totalOutstandingMinor', label: t('reminders.total') }, { key: 'channel', label: t('reminders.channel') }, { key: 'status', label: t('reminders.status') }, { key: 'sentAt', label: t('reminders.sentAt') }]"
    :rows="rows"
  >
    <template #cell-contact="{ row }">{{ row.contact.firstName }} {{ row.contact.lastName }}</template>
    <template #cell-reason="{ row }"><span data-test="reminder-reason">{{ t(`reminders.reasons.${row.reason}`) }}</span></template>
    <template #cell-invoiceNumbers="{ row }">{{ row.invoiceNumbers.join(', ') }}</template>
    <template #cell-totalOutstandingMinor="{ row }"><span data-test="reminder-total">{{ formatMoney(row.totalOutstandingMinor) }}</span></template>
    <template #cell-channel="{ row }">{{ t(`reminders.channels.${row.channel}`) }}</template>
    <template #cell-status="{ row }">
      <span data-test="reminder-status">{{ t(`reminders.statuses.${row.status}`) }}</span>
      <span v-if="row.error" class="ml-1 text-xs text-red-600">{{ errorText(row.error) }}</span>
    </template>
    <template #cell-sentAt="{ row }">{{ date(row.sentAt) }}</template>
    <template #actions="{ row }">
      <a :href="pdfHref(row.id)" target="_blank" rel="noopener" class="rounded-md bg-white px-3 py-2 text-sm ring-1 ring-slate-300" data-test="reminder-pdf">{{ t('reminders.pdf') }}</a>
      <AppButton v-if="row.channel === 'letter' && row.status === 'pending'" variant="secondary" class="ml-2" data-test="reminder-printed" @click="markPrinted(row.id)">{{ t('reminders.markPrinted') }}</AppButton>
    </template>
  </DataTable>
</template>
