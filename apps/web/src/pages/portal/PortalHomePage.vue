<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { InvoiceRow, OwnerStatement } from '@/api/types';
import { usePortalStore } from '@/stores/portal';
import { formatMoney } from '@/utils/money';

const { t } = useI18n();
const portal = usePortalStore();
const invoices = ref<InvoiceRow[]>([]);
const statement = ref<OwnerStatement | null>(null);
const error = ref('');

async function load() {
  const contactId = portal.selectedContactId;
  if (!contactId) { invoices.value = []; statement.value = null; return; }
  error.value = '';
  try {
    const [inv, st] = await Promise.all([
      api.get<{ rows: InvoiceRow[]; total: number }>('/api/portal/invoices', { contactId, pageSize: 12 }),
      api.get<OwnerStatement>('/api/portal/statement', { contactId }),
    ]);
    invoices.value = inv.rows;
    statement.value = st;
  } catch { error.value = t('app.error'); }
}
onMounted(() => { void nextTick(load); });
watch(() => portal.selectedContactId, load);

const unpaidCount = () => invoices.value.filter((i) => i.outstandingMinor > 0).length;
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
      <div><div class="text-sm text-slate-500">{{ t('portal.unpaid') }}</div><div class="text-lg font-semibold" data-test="portal-card-unpaid">{{ unpaidCount() }}</div></div>
      <div><div class="text-sm text-slate-500">{{ t('portal.lastInvoice') }}</div><div class="text-lg font-semibold" data-test="portal-card-last">{{ invoices[0] ? `${invoices[0].period} · ${date(invoices[0].dueAt)}` : '—' }}</div></div>
    </div>
    <RouterLink to="/portal/invoices" class="mt-4 inline-block text-emerald-700 underline" data-test="portal-card-open">{{ t('portal.invoices') }}</RouterLink>
  </div>
</template>
