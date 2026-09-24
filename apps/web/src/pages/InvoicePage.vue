<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { api, API_BASE } from '@/api/client';
import type { Invoice, InvoiceLine } from '@/api/types';
import PaymentForm, { type PaymentPayload } from '@/components/billing/PaymentForm.vue';
import DataTable from '@/components/DataTable.vue';
import ModalDialog from '@/components/ModalDialog.vue';
import AppButton from '@/components/ui/AppButton.vue';
import { formatMoney, percentFromBp } from '@/utils/money';

const props = defineProps<{ id: string }>();
const { t } = useI18n();
const router = useRouter();
const inv = ref<Invoice | null>(null);
const error = ref('');
const payOpen = ref(false);
async function load() { inv.value = await api.get<Invoice>(`/api/invoices/${props.id}`); }
onMounted(load);
async function recordPayment(p: PaymentPayload) {
  try { await api.post(`/api/invoices/${props.id}/payments`, p); payOpen.value = false; await load(); } catch { error.value = t('app.error'); }
}
async function voidPayment(id: string) {
  const reason = window.prompt(t('payments.voidReason'));
  if (!reason) return;
  try { await api.post(`/api/payments/${id}/void`, { reason }); await load(); } catch { error.value = t('app.error'); }
}
const sending = ref(false);
const sendable = computed(() => inv.value !== null && ['published', 'partially_paid', 'paid'].includes(inv.value.status));
const sendState = ref<'idle' | 'sent' | 'failed'>('idle');
async function sendEmail() {
  sending.value = true; sendState.value = 'idle';
  try {
    const res = await api.post<{ status: 'sent' | 'failed' }>(`/api/invoices/${props.id}/send`);
    sendState.value = res.status;
  } catch (e) {
    const code = (e as { code?: string }).code;
    error.value = code === 'no_email' ? t('emails.errors.no_email') : code === 'invoice_not_sendable' ? t('emails.errors.invoice_not_sendable') : t('app.error');
    sendState.value = 'failed';
  } finally { sending.value = false; }
}
const groups = computed(() => {
  const ls = inv.value?.lines ?? [];
  return ([['service', ls.filter((l) => l.kind === 'service' || l.kind === 'manual')], ['management_fee', ls.filter((l) => l.kind === 'management_fee')], ['reserve_fund', ls.filter((l) => l.kind === 'reserve_fund')]] as [InvoiceLine['kind'], InvoiceLine[]][]).filter(([, x]) => x.length);
});
const date = (d: string | null) => (d ? new Date(d).toLocaleDateString('mk-MK') : '—');
async function remove() { try { await api.del(`/api/invoices/${props.id}`); await router.push('/app/invoices'); } catch { error.value = t('app.error'); } }
</script>
<template>
  <div v-if="inv" class="mx-auto max-w-4xl">
    <div class="mb-4 flex items-start justify-between">
      <div><h1 class="text-2xl font-semibold" data-test="invoice-number">{{ inv.number ?? t('invoices.status.draft') }}</h1>
        <p class="text-slate-600">{{ inv.building.name }} · {{ t('billing.period') }} {{ inv.period }} · {{ t(`invoices.status.${inv.status}`) }}</p>
        <p class="text-slate-600">{{ t('invoices.issued') }}: {{ date(inv.issuedAt) }} · {{ t('invoices.due') }}: <span data-test="invoice-due">{{ date(inv.dueAt) }}</span></p></div>
      <div class="flex gap-2">
        <a :href="`${API_BASE}/api/invoices/${inv.id}/html`" target="_blank" rel="noopener" class="rounded-md bg-white px-3 py-2 text-sm ring-1 ring-slate-300" data-test="open-html">{{ t('invoices.openHtml') }}</a>
        <a :href="`${API_BASE}/api/invoices/${inv.id}/pdf`" target="_blank" rel="noopener" class="rounded-md bg-emerald-600 px-3 py-2 text-sm text-white">{{ t('invoices.downloadPdf') }}</a>
        <AppButton v-if="inv.status !== 'draft'" data-test="record-payment" @click="payOpen = true">{{ t('payments.record') }}</AppButton>
        <AppButton v-if="sendable" variant="secondary" :loading="sending" :disabled="!inv.contact.email" data-test="send-email" @click="sendEmail">{{ t('emails.send') }}</AppButton>
        <AppButton v-if="inv.status === 'draft'" variant="danger" @click="remove">{{ t('invoices.deleteDraft') }}</AppButton>
      </div>
    </div>
    <p v-if="sendable" class="mb-2 text-sm" :class="sendState === 'failed' ? 'text-red-600' : 'text-emerald-700'" data-test="send-email-status">
      {{ !inv.contact.email ? t('emails.errors.no_email') : sendState === 'sent' ? t('emails.sent') : sendState === 'failed' ? t('emails.failed') : '' }}
    </p>
    <p v-if="error" class="mb-2 text-sm text-red-600">{{ error }}</p>
    <div class="mb-4 grid grid-cols-2 gap-4 rounded-xl bg-white p-4 shadow-sm">
      <div><div class="text-sm text-slate-500">{{ t('invoices.owner') }}</div><div class="font-medium">{{ inv.contact.firstName }} {{ inv.contact.lastName }}</div><div class="text-sm text-slate-600">{{ inv.contact.address }}</div></div>
      <div><div class="text-sm text-slate-500">{{ t('invoices.units') }}</div><div>{{ [...new Set(inv.lines.map((l) => l.unitLabel))].join(', ') }}</div></div>
    </div>
    <table class="w-full rounded-xl bg-white text-sm shadow-sm">
      <thead class="bg-slate-50 text-left text-slate-600"><tr><th class="px-3 py-2">{{ t('billing.description') }}</th><th class="px-3 py-2">{{ t('units.label') }}</th><th class="px-3 py-2 text-right">{{ t('billing.buildingWide') }}</th><th class="px-3 py-2 text-right">{{ t('billing.ownerShare') }}</th><th class="px-3 py-2 text-right">{{ t('billing.tax') }}</th><th class="px-3 py-2 text-right">{{ t('billing.total') }}</th></tr></thead>
      <tbody>
        <template v-for="[kind, lines] in groups" :key="kind">
          <tr class="bg-slate-50 font-medium"><td colspan="6" class="px-3 py-1">{{ t(`invoices.lineKind.${kind}`) }}</td></tr>
          <tr v-for="l in lines" :key="l.id" class="border-t border-slate-100"><td class="px-3 py-1">{{ l.description }}</td><td class="px-3 py-1">{{ l.unitLabel }}</td><td class="px-3 py-1 text-right">{{ formatMoney(l.buildingWideNetMinor) }}</td><td class="px-3 py-1 text-right">{{ formatMoney(l.ownerNetMinor) }}</td><td class="px-3 py-1 text-right">{{ percentFromBp(l.taxRateBp) }} / {{ formatMoney(l.ownerTaxMinor) }}</td><td class="px-3 py-1 text-right">{{ formatMoney(l.ownerGrossMinor) }}</td></tr>
        </template>
      </tbody>
    </table>
    <div class="mt-4 ml-auto w-80 space-y-1 text-sm">
      <div class="flex justify-between"><span>{{ t('billing.subtotal') }}</span><span>{{ formatMoney(inv.subtotalMinor) }}</span></div>
      <div class="flex justify-between"><span>{{ t('billing.tax') }}</span><span>{{ formatMoney(inv.taxMinor) }}</span></div>
      <div class="flex justify-between font-medium"><span>{{ t('billing.total') }}</span><span data-test="invoice-total">{{ formatMoney(inv.totalMinor) }}</span></div>
      <div class="flex justify-between"><span>{{ t('billing.previousBalance') }}</span><span>{{ formatMoney(inv.previousBalanceMinor) }}</span></div>
      <div class="flex justify-between border-t border-slate-300 pt-1 text-base font-semibold"><span>{{ t('billing.amountDue') }}</span><span>{{ formatMoney(inv.amountDueMinor) }}</span></div>
      <div class="flex justify-between"><span>{{ t('billing.paid') }}</span><span data-test="invoice-paid">{{ formatMoney(inv.paidMinor) }}</span></div>
      <div class="flex justify-between"><span>{{ t('billing.outstanding') }}</span><span data-test="invoice-outstanding">{{ formatMoney(inv.outstandingMinor) }}</span></div>
      <div class="flex justify-between pt-2 text-slate-600"><span>{{ t('invoices.reserveBalance') }}</span><span>{{ formatMoney(inv.reserveFundBuildingBalanceMinor) }}</span></div>
    </div>
    <h2 class="mb-2 mt-6 text-lg font-semibold">{{ t('payments.title') }}</h2>
    <DataTable :columns="[{ key: 'paidAt', label: t('payments.paidAt') }, { key: 'method', label: t('payments.method') }, { key: 'amountMinor', label: t('payments.amount') }, { key: 'reference', label: t('payments.reference') }, { key: 'status', label: t('billing.status') }]" :rows="inv.payments">
      <template #cell-paidAt="{ row }">{{ date(row.paidAt) }}</template>
      <template #cell-method="{ row }">{{ t(`payments.methods.${row.method}`) }}</template>
      <template #cell-amountMinor="{ row }">{{ formatMoney(row.amountMinor) }}</template>
      <template #cell-reference="{ row }">{{ row.reference ?? '—' }}</template>
      <template #cell-status="{ row }">{{ t(`payments.status.${row.status}`) }}</template>
      <template #actions="{ row }"><AppButton v-if="row.status === 'completed'" variant="danger" data-test="void-payment" @click="voidPayment(row.id)">{{ t('payments.void') }}</AppButton></template>
    </DataTable>
    <ModalDialog :open="payOpen" :title="t('payments.record')" @close="payOpen = false">
      <PaymentForm :outstanding-minor="inv.outstandingMinor" @submit="recordPayment" />
    </ModalDialog>
  </div>
  <p v-else>{{ t('app.loading') }}</p>
</template>
