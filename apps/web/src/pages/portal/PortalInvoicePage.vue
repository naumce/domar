<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { api, API_BASE } from '@/api/client';
import type { PortalInvoice } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import { usePortalStore } from '@/stores/portal';
import { formatMoney, percentFromBp } from '@/utils/money';

const props = defineProps<{ id: string }>();
const { t } = useI18n();
const portal = usePortalStore();
const router = useRouter();
const inv = ref<PortalInvoice | null>(null);
const error = ref('');

onMounted(async () => {
  const contactId = portal.selectedContactId;
  if (!contactId) return;
  try { inv.value = await api.get<PortalInvoice>(`/api/portal/invoices/${props.id}`, { contactId }); }
  catch { error.value = t('app.error'); }
});
// The invoice belongs to the contact that was selected when the page loaded; switching the shell's
// contact makes it — and its PDF link — someone else's, so the page steps back to the list.
watch(() => portal.selectedContactId, () => { void router.push('/portal/invoices'); });
// Same shape as the manager's link, so the PDF works in dev (port 3001) and in the single-origin image.
const pdfHref = computed(() => `${API_BASE}/api/portal/invoices/${props.id}/pdf?contactId=${portal.selectedContactId ?? ''}`);
const date = (d: string | null) => (d ? new Date(d).toLocaleDateString('mk-MK') : '—');
</script>
<template>
  <p v-if="error" class="text-sm text-red-600" data-test="portal-page-error">{{ error }}</p>
  <div v-if="inv">
    <div class="mb-4 flex flex-wrap items-start justify-between gap-2">
      <div>
        <h1 class="text-2xl font-semibold" data-test="portal-invoice-number">{{ inv.number ?? inv.id }}</h1>
        <p class="text-slate-600">{{ inv.building.name }} · {{ t('portal.period') }} {{ inv.period }} · {{ t(`invoices.status.${inv.status}`) }}</p>
        <p class="text-slate-600">{{ t('invoices.due') }}: {{ date(inv.dueAt) }}</p>
      </div>
      <a :href="pdfHref" target="_blank" rel="noopener" class="rounded-md bg-emerald-600 px-3 py-2 text-sm text-white" data-test="portal-invoice-pdf">{{ t('portal.downloadPdf') }}</a>
    </div>
    <table class="w-full rounded-xl bg-white text-sm shadow-sm">
      <thead class="bg-slate-50 text-left text-slate-600"><tr><th class="px-3 py-2">{{ t('billing.description') }}</th><th class="px-3 py-2">{{ t('units.label') }}</th><th class="px-3 py-2 text-right">{{ t('billing.buildingWide') }}</th><th class="px-3 py-2 text-right">{{ t('billing.ownerShare') }}</th><th class="px-3 py-2 text-right">{{ t('billing.tax') }}</th><th class="px-3 py-2 text-right">{{ t('billing.total') }}</th></tr></thead>
      <tbody>
        <tr v-for="l in inv.lines" :key="l.id" class="border-t border-slate-100">
          <td class="px-3 py-1">{{ l.description }}</td><td class="px-3 py-1">{{ l.unitLabel }}</td>
          <td class="px-3 py-1 text-right">{{ formatMoney(l.buildingWideNetMinor) }}</td>
          <td class="px-3 py-1 text-right">{{ formatMoney(l.ownerNetMinor) }}</td>
          <td class="px-3 py-1 text-right">{{ percentFromBp(l.taxRateBp) }} / {{ formatMoney(l.ownerTaxMinor) }}</td>
          <td class="px-3 py-1 text-right">{{ formatMoney(l.ownerGrossMinor) }}</td>
        </tr>
      </tbody>
    </table>
    <div class="mt-4 ml-auto w-80 space-y-1 text-sm">
      <div class="flex justify-between"><span>{{ t('billing.subtotal') }}</span><span>{{ formatMoney(inv.subtotalMinor) }}</span></div>
      <div class="flex justify-between"><span>{{ t('billing.tax') }}</span><span>{{ formatMoney(inv.taxMinor) }}</span></div>
      <div class="flex justify-between font-medium"><span>{{ t('portal.total') }}</span><span data-test="portal-invoice-total">{{ formatMoney(inv.totalMinor) }}</span></div>
      <div class="flex justify-between"><span>{{ t('billing.previousBalance') }}</span><span>{{ formatMoney(inv.previousBalanceMinor) }}</span></div>
      <div class="flex justify-between border-t border-slate-300 pt-1 text-base font-semibold"><span>{{ t('billing.amountDue') }}</span><span>{{ formatMoney(inv.amountDueMinor) }}</span></div>
      <div class="flex justify-between"><span>{{ t('billing.paid') }}</span><span>{{ formatMoney(inv.paidMinor) }}</span></div>
      <div class="flex justify-between"><span>{{ t('portal.outstanding') }}</span><span data-test="portal-invoice-outstanding">{{ formatMoney(inv.outstandingMinor) }}</span></div>
      <div class="flex justify-between pt-2 text-slate-600"><span>{{ t('invoices.reserveBalance') }}</span><span>{{ formatMoney(inv.reserveFundBuildingBalanceMinor) }}</span></div>
    </div>
    <h2 class="mb-2 mt-6 text-lg font-semibold">{{ t('portal.payments') }}</h2>
    <DataTable :columns="[{ key: 'paidAt', label: t('portal.date') }, { key: 'method', label: t('payments.method') }, { key: 'amountMinor', label: t('portal.amount') }]" :rows="inv.payments">
      <template #cell-paidAt="{ row }">{{ date(row.paidAt) }}</template>
      <template #cell-method="{ row }">{{ t(`payments.methods.${row.method}`) }}</template>
      <template #cell-amountMinor="{ row }">{{ formatMoney(row.amountMinor) }}</template>
    </DataTable>
    <RouterLink to="/portal/invoices" class="mt-4 inline-block text-emerald-700 underline">{{ t('portal.back') }}</RouterLink>
  </div>
</template>
