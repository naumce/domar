<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, API_BASE, ApiError } from '@/api/client';
import type { AccountCode, AccountCodeList, AccountingExport, AccountingPeriod, AccountingPreview, AccountSlot, Building } from '@/api/types';
import DataTable from '@/components/DataTable.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import { swallow } from '@/composables/useResource';
import { useAuthStore } from '@/stores/auth';
import { formatDateTime, formatMoney } from '@/utils/money';

const SLOTS: AccountSlot[] = [
  'owner_receivable', 'revenue_service', 'revenue_management_fee', 'revenue_reserve_fund',
  'vat_output', 'cash_regular', 'cash_reserve', 'expense_default', 'opening_balance',
];

const { t, te } = useI18n();
const auth = useAuthStore();
// Binding constraint: reads are open to every role, writes are owner/accountant — a role that
// cannot use a control must not be shown it.
const canWrite = computed(() => auth.user?.role === 'owner' || auth.user?.role === 'accountant');
const chart = ref<AccountCodeList>({ rows: [], missing: [] });
const draft = ref<Record<string, { code: string; name: string }>>(Object.fromEntries(SLOTS.map((s) => [s, { code: '', name: '' }])));
const buildings = ref<Building[]>([]);
const periods = ref<AccountingPeriod[]>([]);
const preview = ref<AccountingPreview | null>(null);
const exported = ref<AccountingExport | null>(null);
const from = ref('');
const to = ref('');
const buildingId = ref('');
const period = ref('');
const saved = ref('');
const error = ref('');

const missingNames = computed(() => chart.value.missing.map((s) => t(`accounting.slots.${s}`)).join(', '));
const downloadUrl = computed(() => (exported.value ? `${API_BASE}/api/documents/${exported.value.documentId}/download` : ''));

function fail(e: unknown) {
  const code = e instanceof ApiError ? e.code : (e as { code?: string }).code ?? 'generic';
  error.value = te(`accounting.errors.${code}`) ? t(`accounting.errors.${code}`) : t('accounting.errors.generic');
}

async function loadChart() {
  chart.value = await api.get<AccountCodeList>('/api/account-codes');
  for (const row of chart.value.rows) draft.value[row.slot] = { code: row.code, name: row.name };
}
async function loadPeriods() { periods.value = (await api.get<{ rows: AccountingPeriod[] }>('/api/accounting/periods')).rows; }

onMounted(() => {
  swallow(loadChart());
  swallow(loadPeriods());
  swallow(api.get<{ rows: Building[] }>('/api/buildings').then((r) => { buildings.value = r.rows; }));
});

async function saveSlot(slot: AccountSlot) {
  error.value = ''; saved.value = '';
  try {
    const row = await api.put<AccountCode>(`/api/account-codes/${slot}`, { code: draft.value[slot]!.code, name: draft.value[slot]!.name });
    saved.value = row.slot;
    await loadChart();
  } catch (e) { fail(e); }
}

async function runPreview() {
  error.value = ''; preview.value = null;
  try {
    preview.value = await api.get<AccountingPreview>('/api/accounting/preview', {
      from: from.value, to: to.value, ...(buildingId.value ? { buildingId: buildingId.value } : {}),
    });
  } catch (e) { fail(e); }
}

async function runExport() {
  error.value = ''; exported.value = null;
  try {
    exported.value = await api.post<AccountingExport>('/api/accounting/export', {
      from: from.value, to: to.value, ...(buildingId.value ? { buildingId: buildingId.value } : {}),
    });
  } catch (e) { fail(e); }
}

async function closePeriod() {
  error.value = '';
  try { await api.post<AccountingPeriod>(`/api/accounting/periods/${period.value}/close`); await loadPeriods(); } catch (e) { fail(e); }
}
async function reopenPeriod(p: string) {
  error.value = '';
  try { await api.del(`/api/accounting/periods/${p}`); await loadPeriods(); } catch (e) { fail(e); }
}
</script>
<template>
  <div class="space-y-6">
    <h1 class="text-2xl font-semibold">{{ t('accounting.title') }}</h1>
    <p v-if="error" class="text-sm text-red-600" data-test="page-error">{{ error }}</p>

    <section>
      <h2 class="mb-2 text-lg font-semibold">{{ t('accounting.chart') }}</h2>
      <p class="mb-2 text-sm text-slate-600">{{ t('accounting.chartHint') }}</p>
      <p v-if="chart.missing.length" class="mb-2 text-sm text-red-600" data-test="accounting-missing">
        {{ t('accounting.missing', { slots: missingNames }) }}
      </p>
      <p v-else class="mb-2 text-sm text-green-700" data-test="accounting-complete">{{ t('accounting.complete') }}</p>
      <div v-for="slot in SLOTS" :key="slot" class="mb-2 grid grid-cols-4 items-end gap-2">
        <span class="text-sm">{{ t(`accounting.slots.${slot}`) }}</span>
        <template v-if="canWrite">
          <AppInput v-model="draft[slot]!.code" :label="t('accounting.code')" :data-test="`account-code-${slot}-code`" />
          <AppInput v-model="draft[slot]!.name" :label="t('accounting.name')" :data-test="`account-code-${slot}-name`" />
          <AppButton :data-test="`account-code-${slot}-save`" @click="saveSlot(slot)">{{ t('accounting.save') }}</AppButton>
        </template>
        <template v-else>
          <span class="text-sm">{{ draft[slot]!.code }}</span>
          <span class="text-sm">{{ draft[slot]!.name }}</span>
        </template>
      </div>
      <p v-if="saved" class="text-sm text-green-700" data-test="account-code-saved">{{ t('accounting.saved') }}</p>
    </section>

    <section>
      <h2 class="mb-2 text-lg font-semibold">{{ t('accounting.window') }}</h2>
      <div class="mb-3 grid grid-cols-4 items-end gap-2">
        <AppInput v-model="from" type="date" :label="t('accounting.from')" data-test="accounting-from" />
        <AppInput v-model="to" type="date" :label="t('accounting.to')" data-test="accounting-to" />
        <label class="text-sm">{{ t('accounting.building') }}
          <select v-model="buildingId" class="mt-1 w-full rounded border p-2" data-test="accounting-building">
            <option value="">{{ t('accounting.allBuildings') }}</option>
            <option v-for="b in buildings" :key="b.id" :value="b.id">{{ b.name }}</option>
          </select>
        </label>
        <AppButton data-test="accounting-preview" @click="runPreview">{{ t('accounting.preview') }}</AppButton>
      </div>

      <template v-if="preview">
        <p v-if="preview.balanced" class="mb-2 text-sm text-green-700" data-test="accounting-balanced">{{ t('accounting.balanced') }}</p>
        <p v-else class="mb-2 rounded bg-red-50 p-2 text-sm font-semibold text-red-700" data-test="accounting-unbalanced">{{ t('accounting.unbalanced') }}</p>
        <table class="w-full text-sm">
          <thead>
            <tr><th class="text-left">{{ t('accounting.account') }}</th><th class="text-left">{{ t('accounting.name') }}</th>
            <th class="text-right">{{ t('accounting.debit') }}</th><th class="text-right">{{ t('accounting.credit') }}</th><th class="text-right">{{ t('accounting.difference') }}</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in preview.trialBalance" :key="row.code" data-test="trial-row">
              <td>{{ row.code }}</td><td>{{ row.name }}</td>
              <td class="text-right">{{ formatMoney(row.debitMinor) }}</td>
              <td class="text-right">{{ formatMoney(row.creditMinor) }}</td>
              <td class="text-right">{{ formatMoney(row.differenceMinor) }}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr class="font-semibold">
              <td colspan="2">{{ t('accounting.total') }}</td>
              <td class="text-right" data-test="accounting-total-debit">{{ formatMoney(preview.totals.debitMinor) }}</td>
              <td class="text-right" data-test="accounting-total-credit">{{ formatMoney(preview.totals.creditMinor) }}</td>
              <td class="text-right">{{ formatMoney(preview.totals.debitMinor - preview.totals.creditMinor) }}</td>
            </tr>
          </tfoot>
        </table>
        <p class="mt-2 text-sm text-slate-600">
          {{ t('accounting.entries') }}: {{ preview.totals.entryCount }} ·
          {{ t('accounting.lines') }}: {{ preview.totals.lineCount }} ·
          {{ t('accounting.adjustments') }}: {{ preview.adjustmentCount }}
        </p>
        <div v-if="canWrite" class="mt-3 flex items-center gap-3">
          <AppButton :disabled="!preview.balanced" data-test="accounting-export" @click="runExport">{{ t('accounting.export') }}</AppButton>
          <template v-if="exported">
            <span class="text-sm text-green-700" data-test="accounting-exported">{{ t('accounting.exported') }}</span>
            <a class="text-sm underline" :href="downloadUrl" data-test="accounting-export-download">{{ t('accounting.download') }}</a>
          </template>
        </div>
      </template>
    </section>

    <section>
      <h2 class="mb-2 text-lg font-semibold">{{ t('accounting.periods') }}</h2>
      <p class="mb-2 text-sm text-slate-600">{{ t('accounting.closeHint') }}</p>
      <div v-if="canWrite" class="mb-3 flex items-end gap-2">
        <AppInput v-model="period" :label="t('accounting.period')" placeholder="2026-09" data-test="accounting-period" />
        <AppButton data-test="accounting-close" @click="closePeriod">{{ t('accounting.close') }}</AppButton>
      </div>
      <DataTable
        :columns="[{ key: 'period', label: t('accounting.period') }, { key: 'entryCount', label: t('accounting.entryCount') }, { key: 'closedByName', label: t('accounting.closedBy') }]"
        :rows="periods"
      >
        <template #actions="{ row }">
          <span class="mr-3 text-sm" data-test="accounting-period-row">{{ formatDateTime(row.closedAt) }} · {{ formatMoney(row.debitTotalMinor) }}</span>
          <AppButton v-if="canWrite" variant="secondary" data-test="accounting-reopen" @click="reopenPeriod(row.period)">{{ t('accounting.reopen') }}</AppButton>
        </template>
      </DataTable>
    </section>
  </div>
</template>
