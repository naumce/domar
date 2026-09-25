<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, API_BASE } from '@/api/client';
import type { Assembly, AssemblyOwners, VoteChoice } from '@/api/types';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';

const props = defineProps<{ assembly: Assembly; owners: AssemblyOwners | null; ownersError: string }>();
const emit = defineEmits<{ changed: [Assembly] }>();
const { t, te } = useI18n();

const CHOICES: VoteChoice[] = ['for', 'against', 'abstain'];
const error = ref('');
const busy = ref(false);
const lateOpen = ref(false);
const lateDays = ref(0);
const lateReason = ref('');
const newDecision = ref('');
const heldAt = ref('');
// Keyed by contact id; an unset key reads `undefined`, which a checkbox and an input both treat as empty.
const present = ref<Record<string, boolean>>({});
const proxy = ref<Record<string, string>>({});

const editable = computed(() => props.assembly.status === 'draft' || props.assembly.status === 'invited');
const canDeleteDecision = computed(() => props.assembly.status === 'draft');
const votingOpen = computed(() => props.assembly.status === 'invited');
const held = computed(() => props.assembly.status === 'held');
const quorumLine = computed(() => props.assembly.decisions[0] ?? null);
const message = (e: unknown) => {
  const code = (e as { code?: string }).code ?? 'generic';
  return te(`assemblies.errors.${code}`) ? t(`assemblies.errors.${code}`) : t('app.error');
};
const fmtDateTime = (v: string | null) => (v ? new Date(v).toLocaleString('mk-MK', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const voteOf = (decisionId: string, contactId: string): VoteChoice | '' =>
  props.assembly.votes.find((v) => v.decisionId === decisionId && v.contactId === contactId)?.choice ?? '';
const invitationHref = computed(() => `${API_BASE}/api/assemblies/${props.assembly.id}/invitation/pdf`);
const minutesHref = computed(() => `${API_BASE}/api/documents/${props.assembly.minutesDocumentId}/download`);

async function run(fn: () => Promise<Assembly>) {
  error.value = ''; busy.value = true;
  try { emit('changed', await fn()); } catch (e) { error.value = message(e); } finally { busy.value = false; }
}

async function addDecision() {
  const title = newDecision.value.trim();
  if (!title) return;
  newDecision.value = '';
  await run(() => api.post<Assembly>(`/api/assemblies/${props.assembly.id}/decisions`, { title }));
}
const removeDecision = (decisionId: string) => run(async () => {
  await api.del(`/api/assemblies/${props.assembly.id}/decisions/${decisionId}`);
  return api.get<Assembly>(`/api/assemblies/${props.assembly.id}`);
});

/** Art. 37: a refusal for want of 15 days is not an error, it is a question. */
async function invite() {
  error.value = ''; busy.value = true;
  try {
    emit('changed', await api.post<Assembly>(`/api/assemblies/${props.assembly.id}/invite`, {}));
  } catch (e) {
    const err = e as { code?: string; details?: { days?: number } };
    if (err.code === 'invitation_too_late') { lateDays.value = err.details?.days ?? 0; lateReason.value = ''; lateOpen.value = true; }
    else error.value = message(e);
  } finally { busy.value = false; }
}
async function inviteLate() {
  const reason = lateReason.value.trim();
  if (!reason) return;
  lateOpen.value = false;
  await run(() => api.post<Assembly>(`/api/assemblies/${props.assembly.id}/invite`, { override: { reason } }));
}
const markPrinted = (invitationId: string) => run(() => api.post<Assembly>(`/api/assembly-invitations/${invitationId}/printed`));

/** Typing somebody's paper vote also puts them on the attendance sheet: they took part. */
async function castPaper(decisionId: string, contactId: string, raw: string) {
  if (!raw) return;
  present.value[contactId] = true;
  await run(() => api.post<Assembly>(`/api/assemblies/${props.assembly.id}/decisions/${decisionId}/votes`, { contactId, choice: raw as VoteChoice }));
}

const defaultHeldAt = () => new Date(Math.min(Date.parse(props.assembly.scheduledAt), Date.now())).toISOString();

function hold() {
  const attendance = (props.owners?.rows ?? []).map((o) => ({
    contactId: o.contactId,
    present: present.value[o.contactId] === true,
    proxyName: (proxy.value[o.contactId] ?? '').trim() || null,
  }));
  // A blank field means the moment the manager clicks — but never later than the date the owners
  // were called to (plan addendum 15). Minutes typed three weeks after a meeting held on its
  // scheduled day must not stretch the invitation-to-hold gap by those three weeks and talk the
  // Art. 37 card out of a flag the assembly earned.
  return run(() => api.post<Assembly>(`/api/assemblies/${props.assembly.id}/hold`, {
    heldAt: heldAt.value ? new Date(heldAt.value).toISOString() : defaultHeldAt(),
    attendance,
  }));
}
</script>
<template>
  <section class="mt-6 space-y-5 rounded-xl bg-white p-4 shadow-sm">
    <div class="flex flex-wrap items-center gap-3">
      <h3 class="text-lg font-semibold">{{ fmtDateTime(assembly.scheduledAt) }}</h3>
      <span class="rounded-full bg-slate-100 px-2 py-0.5 text-xs" data-test="assembly-status">{{ t(`assemblies.statuses.${assembly.status}`) }}</span>
      <span class="text-sm text-slate-500">{{ assembly.location || '—' }}</span>
      <span class="text-sm text-slate-500">{{ t(`assemblies.quorumBases.${assembly.quorumBasis}`) }}</span>
      <span v-if="assembly.lateInvitation" class="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800" data-test="assembly-late-badge">{{ t('assemblies.late') }}</span>
    </div>
    <p v-if="error" class="text-sm text-red-600" data-test="assembly-panel-error">{{ error }}</p>
    <p v-if="ownersError" class="text-sm text-red-600" data-test="assembly-owners-error">{{ ownersError }}</p>

    <div>
      <h4 class="font-medium">{{ t('assemblies.agenda') }}</h4>
      <ol class="ml-5 list-decimal text-sm">
        <li v-for="item in assembly.agenda" :key="item.id" data-test="agenda-row">
          {{ item.title }}<span v-if="item.text" class="text-slate-500"> — {{ item.text }}</span>
        </li>
      </ol>
    </div>

    <div>
      <h4 class="font-medium">{{ t('assemblies.decisions') }}</h4>
      <table class="w-full text-sm">
        <thead class="text-left text-slate-600">
          <tr><th class="py-1">{{ t('assemblies.decisionTitle') }}</th><th class="py-1 text-right">{{ t('assemblies.choices.for') }}</th><th class="py-1 text-right">{{ t('assemblies.choices.against') }}</th><th class="py-1 text-right">{{ t('assemblies.choices.abstain') }}</th><th class="py-1">{{ t('assemblies.result') }}</th><th /></tr>
        </thead>
        <tbody>
          <tr v-for="d in assembly.decisions" :key="d.id" class="border-t border-slate-100" data-test="decision-row">
            <td class="py-1">{{ d.title }}</td>
            <td class="py-1 text-right">{{ d.forWeight }}</td>
            <td class="py-1 text-right">{{ d.againstWeight }}</td>
            <td class="py-1 text-right">{{ d.abstainWeight }}</td>
            <td class="py-1" data-test="decision-result">{{ t(`assemblies.results.${d.result}`) }}</td>
            <td class="py-1 text-right"><AppButton v-if="canDeleteDecision" variant="danger" data-test="decision-remove" @click="removeDecision(d.id)">{{ t('app.delete') }}</AppButton></td>
          </tr>
        </tbody>
      </table>
      <div v-if="editable" class="mt-2 flex items-end gap-2">
        <AppInput v-model="newDecision" :label="t('assemblies.decisionTitle')" data-test="assembly-decision-new" />
        <AppButton :loading="busy" data-test="assembly-decision-save" @click="addDecision">{{ t('assemblies.addDecision') }}</AppButton>
      </div>
      <p v-if="held && quorumLine" class="mt-2 text-sm text-slate-600" data-test="assembly-quorum-line">
        {{ t('assemblies.quorum', { present: quorumLine.presentWeight, total: quorumLine.basisTotal }) }} —
        {{ quorumLine.quorumReached ? t('assemblies.quorumReached') : t('assemblies.quorumMissed') }}
      </p>
    </div>

    <div v-if="assembly.status === 'draft'">
      <AppButton :loading="busy" data-test="assembly-invite" @click="invite">{{ t('assemblies.invite') }}</AppButton>
      <div v-if="lateOpen" class="mt-3 rounded-lg border-2 border-amber-300 bg-amber-50 p-3" data-test="assembly-late">
        <p class="mb-2 text-sm text-amber-900">{{ t('assemblies.lateBody', { days: lateDays }) }}</p>
        <div class="flex items-end gap-2">
          <AppInput v-model="lateReason" :label="t('assemblies.lateReason')" data-test="assembly-late-reason" />
          <AppButton :loading="busy" data-test="assembly-late-confirm" @click="inviteLate">{{ t('assemblies.lateConfirm') }}</AppButton>
          <AppButton variant="secondary" data-test="assembly-late-cancel" @click="lateOpen = false">{{ t('app.cancel') }}</AppButton>
        </div>
      </div>
    </div>

    <div v-if="assembly.invitations.length > 0">
      <h4 class="font-medium">{{ t('assemblies.invitations') }} <a :href="invitationHref" target="_blank" rel="noopener" class="ml-2 text-sm text-emerald-700 underline" data-test="assembly-invitation-pdf">{{ t('assemblies.invitationPdf') }}</a></h4>
      <table class="w-full text-sm">
        <thead class="text-left text-slate-600"><tr><th class="py-1">{{ t('assemblies.owner') }}</th><th class="py-1">{{ t('assemblies.channel') }}</th><th class="py-1">{{ t('assemblies.status') }}</th><th /></tr></thead>
        <tbody>
          <tr v-for="i in assembly.invitations" :key="i.id" class="border-t border-slate-100" data-test="invitation-row">
            <td class="py-1">{{ i.contactName }}</td>
            <td class="py-1">{{ t(`assemblies.channels.${i.channel}`) }}</td>
            <td class="py-1">{{ t(`assemblies.invitationStatuses.${i.status}`) }}<span v-if="i.error" class="ml-1 text-xs text-red-600">{{ i.error }}</span></td>
            <td class="py-1 text-right">
              <AppButton v-if="i.status === 'pending' || i.status === 'failed'" variant="secondary" data-test="invitation-printed" @click="markPrinted(i.id)">{{ t('assemblies.markPrinted') }}</AppButton>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="votingOpen && owners">
      <h4 class="font-medium">{{ t('assemblies.attendance') }}</h4>
      <table class="w-full text-sm">
        <thead class="text-left text-slate-600">
          <tr>
            <th class="py-1">{{ t('assemblies.owner') }}</th><th class="py-1 text-right">{{ t('assemblies.weight') }}</th>
            <th class="py-1">{{ t('assemblies.present') }}</th><th class="py-1">{{ t('assemblies.proxy') }}</th>
            <th v-for="d in assembly.decisions" :key="d.id" class="py-1">{{ d.title }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="o in owners.rows" :key="o.contactId" class="border-t border-slate-100" data-test="attendance-row">
            <td class="py-1">{{ o.contactName }}</td>
            <td class="py-1 text-right">{{ o.weightBp }}</td>
            <td class="py-1"><input v-model="present[o.contactId]" type="checkbox" :data-test="`attendance-present-${o.contactId}`" /></td>
            <td class="py-1"><input v-model="proxy[o.contactId]" class="w-32 rounded-md border border-slate-300 px-2 py-1" :data-test="`attendance-proxy-${o.contactId}`" /></td>
            <td v-for="d in assembly.decisions" :key="d.id" class="py-1">
              <select class="rounded-md border border-slate-300 px-2 py-1" :value="voteOf(d.id, o.contactId)" :data-test="`paper-vote-${d.id}-${o.contactId}`"
                @change="castPaper(d.id, o.contactId, ($event.target as HTMLSelectElement).value)">
                <option value="">—</option>
                <option v-for="c in CHOICES" :key="c" :value="c">{{ t(`assemblies.choices.${c}`) }}</option>
              </select>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="mt-3 flex items-end gap-2">
        <AppInput v-model="heldAt" :label="t('assemblies.heldAt')" type="datetime-local" data-test="assembly-held-at" />
        <AppButton :loading="busy" data-test="assembly-hold" @click="hold">{{ t('assemblies.hold') }}</AppButton>
      </div>
    </div>

    <p v-if="held && assembly.minutesDocumentId">
      <a :href="minutesHref" target="_blank" rel="noopener" class="text-sm font-medium text-emerald-700 underline" data-test="assembly-minutes">{{ t('assemblies.minutes') }}</a>
    </p>
  </section>
</template>
