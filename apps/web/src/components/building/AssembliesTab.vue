<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { Assembly, AssemblyOwners, AssemblyRow, QuorumBasis } from '@/api/types';
import AssemblyPanel from '@/components/assembly/AssemblyPanel.vue';
import DataTable from '@/components/DataTable.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';

const props = defineProps<{ buildingId: string }>();
const { t, te } = useI18n();
const BASES: QuorumBasis[] = ['share', 'count'];
const blank = () => ({ scheduledAt: '', location: '', quorumBasis: 'share' as QuorumBasis, agenda: [{ title: '', text: '' }], decisions: [{ title: '' }] });
/** `datetime-local` wants the wall-clock reading, not the ISO instant. */
const toLocalInput = (iso: string): string => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const rows = ref<AssemblyRow[]>([]);
const selected = ref<Assembly | null>(null);
const owners = ref<AssemblyOwners | null>(null);
const ownersError = ref('');
const error = ref('');
const saving = ref(false);
const form = ref(blank());
const editingId = ref<string | null>(null);
const editingOriginal = ref<{ scheduledAt: string; location: string; quorumBasis: QuorumBasis; agenda: { title: string; text: string }[] } | null>(null);

const fmtDateTime = (v: string | null) => (v ? new Date(v).toLocaleString('mk-MK', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const message = (e: unknown) => {
  const code = (e as { code?: string }).code ?? 'generic';
  return te(`assemblies.errors.${code}`) ? t(`assemblies.errors.${code}`) : t('app.error');
};

/** If the assembly being edited stopped being a draft under us (invited from the panel, say), the
 *  schedule is now `schedule_locked` on the server: closing the form here mirrors that. */
async function load() {
  rows.value = (await api.get<{ rows: AssemblyRow[] }>(`/api/buildings/${props.buildingId}/assemblies`)).rows;
  if (editingId.value) {
    const row = rows.value.find((r) => r.id === editingId.value);
    if (!row || row.status !== 'draft') cancelEdit();
  }
}

/** The owner list can legitimately fail (a `share` quorum on a building with no shares), and that
 *  must not blank the panel: the failure belongs on the attendance sheet, where it is actionable. */
async function open(id: string) {
  error.value = ''; ownersError.value = ''; owners.value = null;
  selected.value = await api.get<Assembly>(`/api/assemblies/${id}`);
  try { owners.value = await api.get<AssemblyOwners>(`/api/assemblies/${id}/owners`); }
  catch (e) { ownersError.value = message(e); }
}

onMounted(async () => { try { await load(); } catch { error.value = t('app.error'); } });

const addAgenda = () => form.value.agenda.push({ title: '', text: '' });
const addDecision = () => form.value.decisions.push({ title: '' });

async function create() {
  error.value = '';
  if (!form.value.scheduledAt) { error.value = t('assemblies.errors.validation'); return; }
  saving.value = true;
  try {
    const created = await api.post<Assembly>(`/api/buildings/${props.buildingId}/assemblies`, {
      scheduledAt: new Date(form.value.scheduledAt).toISOString(),
      location: form.value.location,
      quorumBasis: form.value.quorumBasis,
      agenda: form.value.agenda.filter((x) => x.title.trim()).map((x) => ({ title: x.title.trim(), text: x.text.trim() })),
      decisions: form.value.decisions.filter((x) => x.title.trim()).map((x) => ({ title: x.title.trim() })),
    });
    form.value = blank();
    await load();
    await open(created.id);
  } catch (e) { error.value = message(e); } finally { saving.value = false; }
}

function startEdit(row: AssemblyRow) {
  error.value = '';
  editingId.value = row.id;
  editingOriginal.value = {
    scheduledAt: row.scheduledAt, location: row.location, quorumBasis: row.quorumBasis,
    agenda: row.agenda.map((a) => ({ title: a.title, text: a.text })),
  };
  form.value = {
    scheduledAt: toLocalInput(row.scheduledAt), location: row.location, quorumBasis: row.quorumBasis,
    agenda: row.agenda.length > 0 ? row.agenda.map((a) => ({ title: a.title, text: a.text })) : [{ title: '', text: '' }],
    decisions: [{ title: '' }],
  };
}

function cancelEdit() { editingId.value = null; editingOriginal.value = null; form.value = blank(); }

/** Only what actually changed goes in the request: an untouched field must never overwrite itself
 *  with a value the server would (rightly) refuse once the schedule is `schedule_locked`. */
async function update() {
  error.value = '';
  const id = editingId.value; const original = editingOriginal.value;
  if (!id || !original) return;
  saving.value = true;
  try {
    const patch: Record<string, unknown> = {};
    if (form.value.scheduledAt) {
      const iso = new Date(form.value.scheduledAt).toISOString();
      if (iso !== original.scheduledAt) patch.scheduledAt = iso;
    }
    if (form.value.location !== original.location) patch.location = form.value.location;
    if (form.value.quorumBasis !== original.quorumBasis) patch.quorumBasis = form.value.quorumBasis;
    const agenda = form.value.agenda.filter((x) => x.title.trim()).map((x) => ({ title: x.title.trim(), text: x.text.trim() }));
    if (JSON.stringify(agenda) !== JSON.stringify(original.agenda)) patch.agenda = agenda;
    if (Object.keys(patch).length > 0) await api.patch(`/api/assemblies/${id}`, patch);
    cancelEdit();
    await load();
  } catch (e) { error.value = message(e); } finally { saving.value = false; }
}

const submit = () => (editingId.value ? update() : create());

async function cancel(id: string) {
  const reason = window.prompt(t('assemblies.cancelReason'));
  if (!reason) return;
  try {
    await api.post(`/api/assemblies/${id}/cancel`, { reason });
    await load();
    if (selected.value?.id === id) await open(id);
  } catch (e) { error.value = message(e); }
}

async function onChanged(updated: Assembly) { selected.value = updated; await load(); }
</script>
<template>
  <div class="space-y-4">
    <form class="grid grid-cols-4 items-end gap-3 rounded-xl bg-white p-4 shadow-sm" @submit.prevent="submit">
      <AppInput v-model="form.scheduledAt" :label="t('assemblies.scheduledAt')" type="datetime-local" data-test="assembly-scheduled" />
      <AppInput v-model="form.location" :label="t('assemblies.location')" data-test="assembly-location" />
      <AppSelect v-model="form.quorumBasis" :label="t('assemblies.quorumBasis')" :options="BASES.map((k) => ({ value: k, label: t(`assemblies.quorumBases.${k}`) }))" data-test="assembly-quorum" />
      <div class="flex gap-2">
        <AppButton type="button" :loading="saving" data-test="assembly-create" @click="submit">{{ editingId ? t('app.save') : t('assemblies.add') }}</AppButton>
        <AppButton v-if="editingId" type="button" variant="secondary" data-test="assembly-edit-cancel" @click="cancelEdit">{{ t('app.cancel') }}</AppButton>
      </div>
      <div class="col-span-2 space-y-2">
        <div v-for="(item, i) in form.agenda" :key="`agenda-${i}`" class="flex items-end gap-2">
          <AppInput v-model="item.title" :label="t('assemblies.agendaTitle')" data-test="assembly-agenda-title" />
          <AppInput v-model="item.text" :label="t('assemblies.agendaText')" data-test="assembly-agenda-text" />
        </div>
        <AppButton variant="secondary" data-test="assembly-agenda-add" @click="addAgenda">{{ t('assemblies.addAgenda') }}</AppButton>
      </div>
      <div v-if="!editingId" class="col-span-2 space-y-2">
        <div v-for="(item, i) in form.decisions" :key="`decision-${i}`" class="flex items-end gap-2">
          <AppInput v-model="item.title" :label="t('assemblies.decisionTitle')" data-test="assembly-decision-title" />
        </div>
        <AppButton variant="secondary" data-test="assembly-decision-add" @click="addDecision">{{ t('assemblies.addDecision') }}</AppButton>
      </div>
    </form>
    <p v-if="error" class="text-sm text-red-600" data-test="assembly-error">{{ error }}</p>

    <DataTable
      :columns="[{ key: 'scheduledAt', label: t('assemblies.scheduledAt') }, { key: 'location', label: t('assemblies.location') }, { key: 'status', label: t('assemblies.status') }, { key: 'quorumBasis', label: t('assemblies.quorumBasis') }, { key: 'decisionCount', label: t('assemblies.decisions') }]"
      :rows="rows"
    >
      <template #cell-scheduledAt="{ row }"><span data-test="assembly-row">{{ fmtDateTime(row.scheduledAt) }}</span></template>
      <template #cell-status="{ row }">
        <span class="rounded-full bg-slate-100 px-2 py-0.5 text-xs">{{ t(`assemblies.statuses.${row.status}`) }}</span>
        <span v-if="row.lateInvitation" class="ml-1 text-xs text-amber-700">{{ t('assemblies.late') }}</span>
      </template>
      <template #cell-quorumBasis="{ row }">{{ t(`assemblies.quorumBases.${row.quorumBasis}`) }}</template>
      <template #actions="{ row }">
        <AppButton variant="secondary" data-test="assembly-open" @click="open(row.id)">{{ t('assemblies.open') }}</AppButton>
        <AppButton v-if="row.status === 'draft'" variant="secondary" class="ml-2" data-test="assembly-edit" @click="startEdit(row)">{{ t('app.edit') }}</AppButton>
        <AppButton v-if="row.status === 'draft' || row.status === 'invited'" variant="danger" class="ml-2" data-test="assembly-cancel" @click="cancel(row.id)">{{ t('assemblies.cancel') }}</AppButton>
      </template>
    </DataTable>

    <AssemblyPanel v-if="selected" :key="selected.id" :assembly="selected" :owners="owners" :owners-error="ownersError" @changed="onChanged" />
  </div>
</template>
