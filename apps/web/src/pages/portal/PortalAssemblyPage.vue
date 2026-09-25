<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { api, API_BASE } from '@/api/client';
import type { PortalAssembly, VoteChoice } from '@/api/types';
import AppButton from '@/components/ui/AppButton.vue';
import { usePortalStore } from '@/stores/portal';

const props = defineProps<{ id: string }>();
const { t, te } = useI18n();
const portal = usePortalStore();
const router = useRouter();
const assembly = ref<PortalAssembly | null>(null);
const error = ref('');
const busy = ref('');
const CHOICES: VoteChoice[] = ['for', 'against', 'abstain'];

const contactId = computed(() => portal.selectedContactId);
const invitationHref = computed(() => `${API_BASE}/api/portal/assemblies/${props.id}/invitation/pdf?contactId=${contactId.value ?? ''}`);
const minutesHref = computed(() => `${API_BASE}/api/portal/documents/${assembly.value?.minutesDocumentId}/download?contactId=${contactId.value ?? ''}`);
const dateTime = (d: string) => new Date(d).toLocaleString('mk-MK', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

async function load() {
  if (!contactId.value) { assembly.value = null; return; }
  error.value = '';
  try { assembly.value = await api.get<PortalAssembly>(`/api/portal/assemblies/${props.id}`, { contactId: contactId.value }); }
  catch { error.value = t('app.error'); }
}
onMounted(load);
// The assembly belongs to the contact that was selected when the page loaded; switching the shell's
// contact makes it someone else's, so the page steps back to the list (mirrors PortalInvoicePage).
watch(() => portal.selectedContactId, () => { void router.push('/portal/assemblies'); });

async function vote(decisionId: string, choice: VoteChoice) {
  if (!contactId.value) return;
  error.value = ''; busy.value = decisionId;
  try {
    assembly.value = await api.post<PortalAssembly>(`/api/portal/assemblies/${props.id}/decisions/${decisionId}/vote`, { contactId: contactId.value, choice });
  } catch (e) {
    const code = (e as { code?: string }).code ?? 'generic';
    error.value = te(`portal.errors.${code}`) ? t(`portal.errors.${code}`) : t('app.error');
  } finally { busy.value = ''; }
}
</script>
<template>
  <div v-if="assembly">
    <RouterLink to="/portal/assemblies" class="text-sm text-emerald-700 underline">{{ t('portal.back') }}</RouterLink>
    <h1 class="mb-1 mt-2 text-2xl font-semibold">{{ dateTime(assembly.scheduledAt) }}</h1>
    <p class="mb-4 text-sm text-slate-600">
      {{ assembly.buildingName }} · <span data-test="portal-assembly-place">{{ assembly.location || '—' }}</span> ·
      {{ t(`assemblies.statuses.${assembly.status}`) }}
    </p>
    <p v-if="error" class="mb-2 text-sm text-red-600" data-test="portal-page-error">{{ error }}</p>
    <p class="mb-4 flex gap-4 text-sm">
      <a :href="invitationHref" target="_blank" rel="noopener" class="text-emerald-700 underline" data-test="portal-assembly-invitation">{{ t('portal.assemblyInvitation') }}</a>
      <a v-if="assembly.minutesDocumentId" :href="minutesHref" target="_blank" rel="noopener" class="text-emerald-700 underline" data-test="portal-assembly-minutes">{{ t('portal.assemblyMinutes') }}</a>
    </p>

    <section class="mb-6 rounded-xl bg-white p-4 shadow-sm">
      <h2 class="mb-2 font-semibold">{{ t('portal.assemblyAgenda') }}</h2>
      <ol class="ml-5 list-decimal text-sm" data-test="portal-assembly-agenda">
        <li v-for="item in assembly.agenda" :key="item.id">{{ item.title }}<span v-if="item.text" class="text-slate-500"> — {{ item.text }}</span></li>
        <li v-if="assembly.agenda.length === 0" class="list-none text-slate-500">{{ t('app.empty') }}</li>
      </ol>
    </section>

    <section class="space-y-3">
      <h2 class="font-semibold">{{ t('portal.assemblyDecisions') }}</h2>
      <p v-if="!assembly.votingOpen" class="text-sm text-slate-500" data-test="portal-assembly-closed">{{ t('portal.assemblyVotingClosed') }}</p>
      <div v-for="d in assembly.decisions" :key="d.id" class="rounded-xl bg-white p-4 shadow-sm" data-test="portal-assembly-decision">
        <div class="font-medium">{{ d.title }}</div>
        <p v-if="d.text" class="mb-2 text-sm text-slate-600">{{ d.text }}</p>
        <div v-if="assembly.votingOpen" class="mt-2 flex gap-2">
          <AppButton v-for="c in CHOICES" :key="c" :variant="d.myChoice === c ? 'primary' : 'secondary'" :pressed="d.myChoice === c" :loading="busy === d.id" :data-test="`portal-vote-${c}`" @click="vote(d.id, c)">
            {{ t(`portal.assemblyChoices.${c}`) }}
          </AppButton>
        </div>
        <p v-if="d.myChoice" class="mt-2 text-sm text-slate-600" data-test="portal-assembly-mychoice">
          {{ t('portal.assemblyVoted', { choice: t(`portal.assemblyChoices.${d.myChoice}`) }) }}
        </p>
        <p v-if="d.result" class="mt-2 text-sm" data-test="portal-assembly-result">
          {{ t(`portal.assemblyResults.${d.result}`) }} — {{ t('portal.assemblyChoices.for') }} {{ d.forWeight }},
          {{ t('portal.assemblyChoices.against') }} {{ d.againstWeight }}, {{ t('portal.assemblyChoices.abstain') }} {{ d.abstainWeight }}
        </p>
      </div>
      <p v-if="assembly.decisions.length === 0" class="text-sm text-slate-500">{{ t('app.empty') }}</p>
    </section>
  </div>
  <p v-else-if="error" class="text-sm text-red-600" data-test="portal-page-error">{{ error }}</p>
  <p v-else>{{ t('app.loading') }}</p>
</template>
