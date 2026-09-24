<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { Building, BuildingCompliance, ComplianceDuty, LegalEvent } from '@/api/types';
import StatusPill from '@/components/compliance/StatusPill.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';

const props = defineProps<{ buildingId: string }>();
const { t } = useI18n();
const compliance = ref<BuildingCompliance | null>(null);
const events = ref<LegalEvent[]>([]);
const accounts = ref({ regularFundAccount: '', reserveFundAccount: '' });
const saving = ref(false);
const saved = ref(false);
const error = ref('');

const CARD_CLASS: Record<string, string> = {
  ok: 'border-emerald-200', due: 'border-amber-300', overdue: 'border-red-300', 'n/a': 'border-slate-200',
};
const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('mk-MK') : t('compliance.none'));
const fixLink = (duty: ComplianceDuty) => `/app/buildings/${props.buildingId}${duty.howToFix}`;

async function load() {
  error.value = '';
  try {
    compliance.value = await api.get<BuildingCompliance>(`/api/buildings/${props.buildingId}/compliance`);
    const building = await api.get<Building>(`/api/buildings/${props.buildingId}`);
    accounts.value = { regularFundAccount: building.regularFundAccount ?? '', reserveFundAccount: building.reserveFundAccount ?? '' };
    events.value = (await api.get<{ rows: LegalEvent[] }>(`/api/buildings/${props.buildingId}/legal-events`, { pageSize: 10 })).rows;
  } catch { error.value = t('app.error'); }
}
onMounted(load);

/** The Art. 42/45 fix lives on this screen, because the deep link of that duty points back here. */
async function saveAccounts() {
  saving.value = true; error.value = ''; saved.value = false;
  try {
    await api.patch(`/api/buildings/${props.buildingId}`, {
      regularFundAccount: accounts.value.regularFundAccount.trim() || null,
      reserveFundAccount: accounts.value.reserveFundAccount.trim() || null,
    });
    await load();
    saved.value = true;
  } catch { error.value = t('app.error'); } finally { saving.value = false; }
}
</script>
<template>
  <div v-if="compliance" class="space-y-6">
    <div class="flex items-center gap-3">
      <h2 class="text-lg font-semibold">{{ t('compliance.title') }}</h2>
      <StatusPill :status="compliance.status" data-test="compliance-status" />
      <span class="text-sm text-slate-500">{{ t('compliance.evaluatedAt', { date: fmtDate(compliance.evaluatedAt) }) }}</span>
    </div>
    <p v-if="error" class="text-sm text-red-600" data-test="page-error">{{ error }}</p>

    <div class="grid grid-cols-2 gap-4">
      <section v-for="duty in compliance.duties" :key="duty.key" class="rounded-xl border-2 bg-white p-4 shadow-sm" :class="CARD_CLASS[duty.status]" :data-test="`compliance-card-${duty.key}`">
        <div class="mb-1 flex items-start justify-between gap-2">
          <div>
            <div class="font-medium">{{ duty.label }}</div>
            <div class="text-xs text-slate-500">{{ t('compliance.article', { article: duty.article }) }}</div>
          </div>
          <StatusPill :status="duty.status" :data-test="`compliance-card-${duty.key}-status`" />
        </div>
        <p class="mb-2 text-sm text-slate-600">{{ duty.hint }}</p>
        <dl class="mb-3 grid grid-cols-2 gap-1 text-xs text-slate-600">
          <dt>{{ t('compliance.lastEvidence') }}</dt><dd>{{ fmtDate(duty.lastEvidenceAt) }}</dd>
          <dt>{{ t('compliance.dueAt') }}</dt><dd>{{ fmtDate(duty.dueAt) }}</dd>
          <template v-if="duty.count !== null"><dt>{{ t('compliance.count') }}</dt><dd>{{ duty.count }}</dd></template>
        </dl>
        <RouterLink :to="fixLink(duty)" class="text-sm font-medium text-emerald-700 underline" :data-test="`compliance-fix-${duty.key}`">{{ t('compliance.fix') }}</RouterLink>
      </section>
    </div>

    <section id="fund-accounts" class="rounded-xl bg-white p-4 shadow-sm">
      <h3 class="mb-3 font-semibold">{{ t('compliance.fundAccounts.title') }}</h3>
      <div class="grid grid-cols-3 items-end gap-3">
        <AppInput v-model="accounts.regularFundAccount" :label="t('compliance.fundAccounts.regular')" data-test="fund-accounts-regular" placeholder="210-0000000000-19" />
        <AppInput v-model="accounts.reserveFundAccount" :label="t('compliance.fundAccounts.reserve')" data-test="fund-accounts-reserve" placeholder="210-0000000000-96" />
        <AppButton :loading="saving" data-test="fund-accounts-save" @click="saveAccounts">{{ t('app.save') }}</AppButton>
      </div>
      <p v-if="saved" class="mt-2 text-sm text-emerald-700" data-test="fund-accounts-saved">{{ t('compliance.fundAccounts.saved') }}</p>
    </section>

    <section>
      <h3 class="mb-2 font-semibold">{{ t('compliance.events') }}</h3>
      <ul class="divide-y divide-slate-100 rounded-xl bg-white shadow-sm">
        <li v-if="events.length === 0" class="px-4 py-6 text-center text-slate-500">{{ t('app.empty') }}</li>
        <li v-for="e in events" :key="e.id" class="flex items-center justify-between px-4 py-2 text-sm" data-test="compliance-event">
          <span>{{ t(`compliance.eventKinds.${e.kind}`) }}</span>
          <span class="text-slate-500">{{ fmtDate(e.occurredAt) }}</span>
        </li>
      </ul>
    </section>
  </div>
  <p v-else-if="error" class="text-sm text-red-600" data-test="page-error">{{ error }}</p>
  <p v-else>{{ t('app.loading') }}</p>
</template>
