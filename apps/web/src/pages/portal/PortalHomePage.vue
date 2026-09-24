<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { InvoiceRow, OwnerStatement } from '@/api/types';
import { usePortalStore } from '@/stores/portal';
import { formatMoney } from '@/utils/money';

const { t } = useI18n();
const portal = usePortalStore();
const invoices = ref<InvoiceRow[]>([]);
const statement = ref<OwnerStatement | null>(null);
const unpaidCount = ref(0);
const error = ref('');

type InvoicePage = { rows: InvoiceRow[]; total: number };
const invoicePage = (contactId: string, query: Record<string, string | number>) =>
  api.get<InvoicePage>('/api/portal/invoices', { contactId, ...query });

async function load() {
  const contactId = portal.selectedContactId;
  if (!contactId) { invoices.value = []; statement.value = null; unpaidCount.value = 0; return; }
  error.value = '';
  try {
    // The unpaid number is counted by the API — the first page would miss the thirteenth open invoice.
    const [inv, st, published, partiallyPaid] = await Promise.all([
      invoicePage(contactId, { pageSize: 12 }),
      api.get<OwnerStatement>('/api/portal/statement', { contactId }),
      invoicePage(contactId, { status: 'published', pageSize: 1 }),
      invoicePage(contactId, { status: 'partially_paid', pageSize: 1 }),
    ]);
    invoices.value = inv.rows;
    statement.value = st;
    unpaidCount.value = published.total + partiallyPaid.total;
  } catch { error.value = t('app.error'); }
}
onMounted(load);
watch(() => portal.selectedContactId, load);

const date = (d: string | null) => (d ? new Date(d).toLocaleDateString('mk-MK') : '—');
</script>
<template>
  <h1 class="mb-4 text-2xl font-semibold">{{ t('portal.title') }}</h1>
  <p v-if="error" class="mb-2 text-sm text-red-600" data-test="portal-page-error">{{ error }}</p>
  <p v-if="portal.links.length === 0" data-test="portal-no-links">{{ t('portal.noLinks') }}</p>
  <div v-else-if="portal.current" class="rounded-xl bg-white p-4 shadow-sm" data-test="portal-card">
    <div class="text-sm text-slate-500">{{ t('portal.manager') }}</div>
    <div class="font-medium" data-test="portal-card-manager">{{ portal.current.tenantName }}</div>
    <div class="mt-2 text-sm text-slate-500">{{ t('portal.buildings') }}</div>
    <div data-test="portal-card-buildings">{{ portal.current.buildings.map((b) => b.name).join(', ') || '—' }}</div>
    <div class="mt-4 grid grid-cols-3 gap-4">
      <div><div class="text-sm text-slate-500">{{ t('portal.balance') }}</div><div class="text-lg font-semibold" data-test="portal-card-balance">{{ formatMoney(statement?.balanceMinor ?? 0) }}</div></div>
      <div><div class="text-sm text-slate-500">{{ t('portal.unpaid') }}</div><div class="text-lg font-semibold" data-test="portal-card-unpaid">{{ unpaidCount }}</div></div>
      <div><div class="text-sm text-slate-500">{{ t('portal.lastInvoice') }}</div><div class="text-lg font-semibold" data-test="portal-card-last">{{ invoices[0] ? `${invoices[0].period} · ${date(invoices[0].dueAt)}` : '—' }}</div></div>
    </div>
    <RouterLink to="/portal/invoices" class="mt-4 inline-block text-emerald-700 underline" data-test="portal-card-open">{{ t('portal.invoices') }}</RouterLink>
  </div>
</template>
