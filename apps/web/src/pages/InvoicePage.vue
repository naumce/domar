<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { api } from '@/api/client';
import type { Invoice, InvoiceLine } from '@/api/types';
import AppButton from '@/components/ui/AppButton.vue';
import { formatMoney, percentFromBp } from '@/utils/money';

const props = defineProps<{ id: string }>();
const { t } = useI18n();
const router = useRouter();
const API = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3001';
const inv = ref<Invoice | null>(null);
const error = ref('');
onMounted(async () => { inv.value = await api.get<Invoice>(`/api/invoices/${props.id}`); });
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
        <a :href="`${API}/api/invoices/${inv.id}/html`" target="_blank" rel="noopener" class="rounded-md bg-white px-3 py-2 text-sm ring-1 ring-slate-300" data-test="open-html">{{ t('invoices.openHtml') }}</a>
        <a :href="`${API}/api/invoices/${inv.id}/pdf`" target="_blank" rel="noopener" class="rounded-md bg-emerald-600 px-3 py-2 text-sm text-white">{{ t('invoices.downloadPdf') }}</a>
        <AppButton v-if="inv.status === 'draft'" variant="danger" @click="remove">{{ t('invoices.deleteDraft') }}</AppButton>
      </div>
    </div>
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
      <div class="flex justify-between pt-2 text-slate-600"><span>{{ t('invoices.reserveBalance') }}</span><span>{{ formatMoney(inv.reserveFundBuildingBalanceMinor) }}</span></div>
    </div>
  </div>
  <p v-else>{{ t('app.loading') }}</p>
</template>
