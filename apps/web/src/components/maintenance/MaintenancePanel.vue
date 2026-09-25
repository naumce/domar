<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, API_BASE } from '@/api/client';
import type { Fund, MaintenanceRequest, MaintenanceVisibility, Supplier, User } from '@/api/types';
import ModalDialog from '@/components/ModalDialog.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import { formatMoney, toMinor } from '@/utils/money';

const props = defineProps<{ request: MaintenanceRequest; users: User[]; suppliers: Supplier[]; canWrite: boolean }>();
const emit = defineEmits<{ (e: 'updated', request: MaintenanceRequest): void; (e: 'error', message: string): void }>();
const { t, te } = useI18n();

const assign = ref({ assigneeUserId: '', supplierId: '' });
const closing = ref(false);
const close = ref({ fund: 'reserve' as Fund, amount: '', supplierId: '', note: '' });
const note = ref({ text: '', visibility: 'internal' as MaintenanceVisibility });
const file = ref<File | null>(null);
const busy = ref('');

const status = computed(() => props.request.status);
const open = computed(() => status.value !== 'done' && status.value !== 'rejected');
const mayTriage = computed(() => props.canWrite && status.value === 'new');
const mayReject = computed(() => props.canWrite && (status.value === 'new' || status.value === 'triaged'));
const mayAssign = computed(() => props.canWrite && open.value);
const mayStart = computed(() => status.value === 'assigned');
const mayClose = computed(() => status.value === 'assigned' || status.value === 'in_progress');
const downloadUrl = (id: string) => `${API_BASE}/api/documents/${id}/download`;
const dateTime = (iso: string) => new Date(iso).toLocaleString('mk-MK', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

function fail(e: unknown) {
  const code = (e as { code?: string }).code ?? 'generic';
  emit('error', te(`maintenance.errors.${code}`) ? t(`maintenance.errors.${code}`) : t('app.error'));
}

async function send(label: string, run: () => Promise<MaintenanceRequest>) {
  busy.value = label;
  try { emit('updated', await run()); } catch (e) { fail(e); } finally { busy.value = ''; }
}

const setStatus = (body: Record<string, unknown>, label: string) =>
  send(label, () => api.post<MaintenanceRequest>(`/api/maintenance-requests/${props.request.id}/status`, body));

function submitAssign() {
  if (!assign.value.assigneeUserId) { emit('error', t('maintenance.errors.validation')); return; }
  void send('assign', () => api.post<MaintenanceRequest>(`/api/maintenance-requests/${props.request.id}/assign`, {
    assigneeUserId: assign.value.assigneeUserId,
    supplierId: assign.value.supplierId || null,
  }));
}

function submitClose() {
  const costMinor = toMinor(close.value.amount);
  // An unparsed amount would silently become a zero and book a 0,00 den expense on the fund.
  if (costMinor === null || costMinor <= 0) { emit('error', t('maintenance.errors.validation')); return; }
  closing.value = false;
  void setStatus({
    status: 'done', note: close.value.note.trim() || undefined, visibility: 'owner',
    cost: { fund: close.value.fund, costMinor, ...(close.value.supplierId ? { supplierId: close.value.supplierId } : {}) },
  }, 'close');
}

function submitNote() {
  if (!note.value.text.trim()) { emit('error', t('maintenance.errors.validation')); return; }
  const body = { note: note.value.text.trim(), visibility: note.value.visibility };
  note.value = { text: '', visibility: 'internal' };
  void send('note', () => api.post<MaintenanceRequest>(`/api/maintenance-requests/${props.request.id}/events`, body));
}

function onFile(e: Event) { file.value = (e.target as HTMLInputElement).files?.[0] ?? null; }

function uploadPhoto() {
  if (!file.value) { emit('error', t('maintenance.errors.file_required')); return; }
  const fd = new FormData();
  // Order matters: busboy only exposes the fields that precede the file part.
  fd.append('title', file.value.name);
  fd.append('file', file.value, file.value.name);
  file.value = null;
  void send('photo', () => api.upload<MaintenanceRequest>(`/api/maintenance-requests/${props.request.id}/photos`, fd));
}

async function removePhoto(documentId: string) {
  if (!window.confirm(t('app.confirmDelete'))) return;
  busy.value = documentId;
  try {
    await api.del(`/api/maintenance-requests/${props.request.id}/photos/${documentId}`);
    emit('updated', await api.get<MaintenanceRequest>(`/api/maintenance-requests/${props.request.id}`));
  } catch (e) { fail(e); } finally { busy.value = ''; }
}
</script>
<template>
  <section class="rounded-xl bg-white p-4 shadow-sm" data-test="maintenance-panel">
    <div class="mb-1 flex flex-wrap items-center gap-2">
      <h3 class="text-lg font-semibold">{{ request.title }}</h3>
      <span class="rounded-full bg-slate-100 px-2 py-0.5 text-xs" data-test="maintenance-panel-status">{{ t(`maintenance.statuses.${request.status}`) }}</span>
      <span class="rounded-full bg-slate-100 px-2 py-0.5 text-xs">{{ t(`maintenance.categories.${request.category}`) }}</span>
      <span class="rounded-full bg-slate-100 px-2 py-0.5 text-xs">{{ t(`maintenance.priorities.${request.priority}`) }}</span>
    </div>
    <p class="mb-3 whitespace-pre-line text-sm text-slate-700">{{ request.description }}</p>
    <dl class="mb-4 grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
      <div><dt class="text-slate-500">{{ t('maintenance.reporter') }}</dt><dd>{{ request.reporterName }}</dd></div>
      <div><dt class="text-slate-500">{{ t('maintenance.unit') }}</dt><dd>{{ request.unitLabel ?? t('maintenance.noUnit') }}</dd></div>
      <div><dt class="text-slate-500">{{ t('maintenance.assignee') }}</dt><dd>{{ request.assigneeName ?? '—' }}</dd></div>
      <div><dt class="text-slate-500">{{ t('maintenance.supplier') }}</dt><dd>{{ request.supplierName ?? '—' }}</dd></div>
      <div v-if="request.costMinor !== null"><dt class="text-slate-500">{{ t('maintenance.cost') }}</dt>
        <dd data-test="maintenance-panel-cost">{{ formatMoney(request.costMinor) }} · {{ t(`maintenance.funds.${request.fund}`) }}</dd></div>
      <div v-if="request.closedAt"><dt class="text-slate-500">{{ t('maintenance.closedAt') }}</dt><dd>{{ dateTime(request.closedAt) }}</dd></div>
    </dl>

    <div class="mb-4 flex flex-wrap gap-2">
      <AppButton v-if="mayTriage" :loading="busy === 'triage'" data-test="maintenance-triage" @click="setStatus({ status: 'triaged' }, 'triage')">{{ t('maintenance.triage') }}</AppButton>
      <AppButton v-if="mayReject" variant="danger" :loading="busy === 'reject'" data-test="maintenance-reject" @click="setStatus({ status: 'rejected' }, 'reject')">{{ t('maintenance.reject') }}</AppButton>
      <AppButton v-if="mayStart" :loading="busy === 'start'" data-test="maintenance-start" @click="setStatus({ status: 'in_progress' }, 'start')">{{ t('maintenance.start') }}</AppButton>
      <AppButton v-if="mayClose" variant="secondary" :loading="busy === 'free'" data-test="maintenance-close-free" @click="setStatus({ status: 'done', cost: null }, 'free')">{{ t('maintenance.closeWithoutCost') }}</AppButton>
      <AppButton v-if="mayClose && canWrite" data-test="maintenance-close-open" @click="closing = true">{{ t('maintenance.closeWithCost') }}</AppButton>
    </div>

    <form v-if="mayAssign" class="mb-4 grid grid-cols-3 items-end gap-3" @submit.prevent="submitAssign">
      <AppSelect v-model="assign.assigneeUserId" :label="t('maintenance.assignee')" data-test="maintenance-assignee"
        :options="[{ value: '', label: t('maintenance.pickAssignee') }, ...users.map((u) => ({ value: u.id, label: `${u.firstName} ${u.lastName}` }))]" />
      <AppSelect v-model="assign.supplierId" :label="t('maintenance.supplier')" data-test="maintenance-supplier"
        :options="[{ value: '', label: t('maintenance.noSupplier') }, ...suppliers.map((s) => ({ value: s.id, label: s.name }))]" />
      <AppButton type="button" :loading="busy === 'assign'" data-test="maintenance-assign" @click="submitAssign">{{ t('maintenance.assign') }}</AppButton>
    </form>

    <section class="mb-4">
      <h4 class="mb-2 font-medium">{{ t('maintenance.photos') }}</h4>
      <div class="mb-2 flex flex-wrap gap-3">
        <div v-for="p in request.photos" :key="p.documentId" class="text-xs">
          <a :href="downloadUrl(p.documentId)" target="_blank" rel="noopener" class="text-emerald-700 underline" data-test="maintenance-photo">{{ p.fileName }}</a>
          <span class="ml-1 text-slate-500">{{ p.uploadedByName }}</span>
          <button v-if="canWrite" class="ml-2 text-red-600 underline" data-test="maintenance-photo-delete" @click="removePhoto(p.documentId)">{{ t('app.delete') }}</button>
        </div>
        <p v-if="request.photos.length === 0" class="text-sm text-slate-500">{{ t('app.empty') }}</p>
      </div>
      <div v-if="open" class="flex items-end gap-3">
        <label class="block text-sm"><span class="mb-1 block font-medium text-slate-700">{{ t('maintenance.file') }}</span>
          <input type="file" class="text-sm" accept="image/png,image/jpeg" data-test="maintenance-photo-file" @change="onFile" /></label>
        <AppButton type="button" :loading="busy === 'photo'" data-test="maintenance-photo-upload" @click="uploadPhoto">{{ t('maintenance.upload') }}</AppButton>
      </div>
    </section>

    <section>
      <h4 class="mb-2 font-medium">{{ t('maintenance.events') }}</h4>
      <ol class="mb-3 space-y-2 text-sm">
        <li v-for="e in request.events" :key="e.id" class="rounded-lg bg-slate-50 p-2" data-test="maintenance-event">
          <span class="font-medium">{{ t(`maintenance.eventKinds.${e.kind}`) }}</span>
          <span v-if="e.toStatus" class="text-slate-600"> → {{ t(`maintenance.statuses.${e.toStatus}`) }}</span>
          <span class="ml-2 text-xs text-slate-500">{{ e.authorName }} · {{ dateTime(e.createdAt) }} · {{ t(`maintenance.visibilities.${e.visibility}`) }}</span>
          <p v-if="e.note" class="whitespace-pre-line">{{ e.note }}</p>
        </li>
      </ol>
      <form v-if="open" class="grid grid-cols-3 items-end gap-3" @submit.prevent="submitNote">
        <AppInput v-model="note.text" :label="t('maintenance.note')" data-test="maintenance-note" />
        <AppSelect v-model="note.visibility" :label="t('maintenance.visibility')" data-test="maintenance-note-visibility"
          :options="[{ value: 'internal', label: t('maintenance.visibilities.internal') }, { value: 'owner', label: t('maintenance.visibilities.owner') }]" />
        <AppButton type="button" :loading="busy === 'note'" data-test="maintenance-note-add" @click="submitNote">{{ t('maintenance.addNote') }}</AppButton>
      </form>
    </section>

    <ModalDialog :open="closing" :title="t('maintenance.closeWithCost')" @close="closing = false">
      <form class="space-y-3" @submit.prevent="submitClose">
        <AppSelect v-model="close.fund" :label="t('maintenance.fund')" data-test="maintenance-close-fund"
          :options="[{ value: 'reserve', label: t('maintenance.funds.reserve') }, { value: 'regular', label: t('maintenance.funds.regular') }]" />
        <AppInput v-model="close.amount" :label="t('maintenance.cost')" placeholder="0,00" data-test="maintenance-close-amount" />
        <AppSelect v-model="close.supplierId" :label="t('maintenance.supplier')" data-test="maintenance-close-supplier"
          :options="[{ value: '', label: t('maintenance.noSupplier') }, ...suppliers.map((s) => ({ value: s.id, label: s.name }))]" />
        <AppInput v-model="close.note" :label="t('maintenance.note')" data-test="maintenance-close-note" />
        <AppButton type="button" :loading="busy === 'close'" data-test="maintenance-close-submit" @click="submitClose">{{ t('maintenance.close') }}</AppButton>
      </form>
    </ModalDialog>
  </section>
</template>
