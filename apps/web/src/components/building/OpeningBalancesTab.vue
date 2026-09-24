<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { Fund, OpeningBalanceList, OwnerOpeningBalance } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import AppButton from '@/components/ui/AppButton.vue';
import { formatMoney, toMinor } from '@/utils/money';

const props = defineProps<{ buildingId: string }>();
const { t } = useI18n();
const base = `/api/buildings/${props.buildingId}/opening-balances`;
const rows = ref<OwnerOpeningBalance[]>([]);
const published = ref(false);
const force = ref(false);
const amounts = ref<Record<string, string>>({});
const funds = ref<Record<string, Fund>>({});
const error = ref(''); const saved = ref(false); const busy = ref(false);
const invalidContactId = ref<string | null>(null);

async function load() {
  const res = await api.get<OpeningBalanceList>(base);
  rows.value = res.rows;
  published.value = res.hasPublishedPeriod;
  funds.value = Object.fromEntries(res.rows.map((r) => [r.contactId, (funds.value[r.contactId] ?? 'regular') as Fund]));
}
onMounted(async () => { try { await load(); } catch { error.value = t('app.error'); } });

async function save() {
  error.value = ''; saved.value = false; invalidContactId.value = null;
  const payload: { contactId: string; fund: Fund; amountMinor: number }[] = [];
  for (const row of rows.value) {
    const raw = (amounts.value[row.contactId] ?? '').trim();
    if (!raw) continue;
    const amountMinor = toMinor(raw);
    if (amountMinor === null || amountMinor === 0) { invalidContactId.value = row.contactId; error.value = t('openingBalances.errors.invalid_amount'); return; }
    payload.push({ contactId: row.contactId, fund: funds.value[row.contactId] ?? 'regular', amountMinor });
  }
  if (payload.length === 0) { error.value = t('auth.errors.validation'); return; }
  busy.value = true;
  try {
    await api.post(base, { rows: payload, force: force.value });
    amounts.value = {}; saved.value = true;
    await load();
  } catch (e) {
    const code = (e as { code?: string }).code;
    error.value = code === 'period_published' ? t('openingBalances.errors.period_published')
      : code === 'invalid_reference' ? t('openingBalances.errors.invalid_reference')
      : t('app.error');
  } finally { busy.value = false; }
}
</script>
<template>
  <p v-if="published" class="mb-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900" data-test="ob-published">{{ t('openingBalances.publishedWarning') }}</p>
  <p v-if="error" class="mb-2 text-sm text-red-600" data-test="ob-error">{{ error }}</p>
  <p v-if="saved" class="mb-2 text-sm text-emerald-700" data-test="ob-saved">{{ t('openingBalances.saved') }}</p>
  <DataTable
    :columns="[{ key: 'owner', label: t('openingBalances.owner') }, { key: 'regularMinor', label: t('openingBalances.regular') }, { key: 'reserveMinor', label: t('openingBalances.reserve') }, { key: 'balanceMinor', label: t('openingBalances.balance') }, { key: 'openingMinor', label: t('openingBalances.alreadyEntered') }, { key: 'amount', label: t('openingBalances.amount') }, { key: 'fund', label: t('openingBalances.fund') }]"
    :rows="rows.map((r) => ({ ...r, id: r.contactId }))">
    <template #cell-owner="{ row }">{{ row.firstName }} {{ row.lastName }}</template>
    <template #cell-regularMinor="{ row }">{{ formatMoney(row.regularMinor) }}</template>
    <template #cell-reserveMinor="{ row }">{{ formatMoney(row.reserveMinor) }}</template>
    <template #cell-balanceMinor="{ row }"><span :data-test="`ob-balance-${row.contactId}`">{{ formatMoney(row.balanceMinor) }}</span></template>
    <template #cell-openingMinor="{ row }">{{ formatMoney(row.openingMinor) }}</template>
    <template #cell-amount="{ row }">
      <input v-model="amounts[row.contactId]" :data-test="`ob-amount-${row.contactId}`" placeholder="1.200,00"
        class="w-32 rounded-md border px-2 py-1 focus:border-emerald-500 focus:outline-none"
        :class="invalidContactId === row.contactId ? 'border-red-500' : 'border-slate-300'" />
    </template>
    <template #cell-fund="{ row }">
      <select v-model="funds[row.contactId]" :data-test="`ob-fund-${row.contactId}`" class="rounded-md border border-slate-300 bg-white px-2 py-1">
        <option value="regular">{{ t('billing.regular') }}</option>
        <option value="reserve">{{ t('billing.reserve') }}</option>
      </select>
    </template>
  </DataTable>
  <p v-if="rows.length === 0" class="mt-3 text-sm text-slate-500">{{ t('openingBalances.empty') }}</p>
  <div class="mt-4 flex items-center justify-end gap-4">
    <label v-if="published" class="text-sm"><input v-model="force" type="checkbox" data-test="ob-force" /> {{ t('openingBalances.force') }}</label>
    <AppButton :loading="busy" data-test="ob-save" @click="save">{{ t('openingBalances.save') }}</AppButton>
  </div>
</template>
