<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { ComplianceOverview, ComplianceStatus } from '@/api/types';
import StatusPill from '@/components/compliance/StatusPill.vue';

const { t } = useI18n();
const overview = ref<ComplianceOverview | null>(null);
const error = ref('');
const DOT: Record<ComplianceStatus, string> = {
  ok: 'bg-emerald-500', due: 'bg-amber-500', overdue: 'bg-red-500', 'n/a': 'bg-slate-300',
};
const KEY: Record<ComplianceStatus, string> = { ok: 'ok', due: 'due', overdue: 'overdue', 'n/a': 'na' };
/** The API keeps its rows ordered by building name; the worst-first order shown here is the web's own. */
const RANK: Record<ComplianceStatus, number> = { overdue: 0, due: 1, ok: 2, 'n/a': 3 };
const sortedRows = computed(() => [...(overview.value?.rows ?? [])].sort((a, b) => RANK[a.status] - RANK[b.status]));
onMounted(async () => {
  try { overview.value = await api.get<ComplianceOverview>('/api/compliance'); } catch { error.value = t('app.error'); }
});
</script>
<template>
  <div v-if="overview">
    <h1 class="mb-4 text-2xl font-semibold">{{ t('compliance.overview') }}</h1>
    <div class="mb-4 flex gap-3 text-sm">
      <span v-for="s in (['overdue', 'due', 'ok', 'n/a'] as ComplianceStatus[])" :key="s" class="rounded-lg bg-white px-3 py-2 shadow-sm">
        {{ t(`compliance.status.${KEY[s]}`) }}: <b :data-test="`compliance-total-${KEY[s]}`">{{ overview.counts[KEY[s] as 'ok' | 'due' | 'overdue' | 'na'] }}</b>
      </span>
    </div>
    <div class="overflow-x-auto rounded-xl bg-white shadow-sm">
      <table class="w-full text-sm">
        <thead class="bg-slate-50 text-left text-slate-600"><tr><th class="px-4 py-2 font-medium">{{ t('compliance.building') }}</th><th class="px-4 py-2 font-medium">{{ t('compliance.worst') }}</th><th class="px-4 py-2 font-medium">{{ t('compliance.duties') }}</th></tr></thead>
        <tbody>
          <tr v-if="overview.rows.length === 0"><td colspan="3" class="px-4 py-6 text-center text-slate-500">{{ t('app.empty') }}</td></tr>
          <tr v-for="row in sortedRows" :key="row.building.id" class="border-t border-slate-100" data-test="compliance-row">
            <td class="px-4 py-2"><RouterLink :to="`/app/buildings/${row.building.id}?tab=compliance`" class="text-emerald-700 underline">{{ row.building.name }}</RouterLink></td>
            <td class="px-4 py-2"><StatusPill :status="row.status" data-test="compliance-row-status" /></td>
            <td class="px-4 py-2">
              <span v-for="d in row.duties" :key="d.key" class="mr-1 inline-block h-3 w-3 rounded-full align-middle" :class="DOT[d.status]" :title="d.key" :data-test="`compliance-dot-${d.key}`" />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
  <p v-else-if="error" class="text-sm text-red-600" data-test="page-error">{{ error }}</p>
  <p v-else>{{ t('app.loading') }}</p>
</template>
