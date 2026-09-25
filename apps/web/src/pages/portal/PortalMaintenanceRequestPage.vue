<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { api, API_BASE } from '@/api/client';
import type { PortalMaintenanceRequest } from '@/api/types';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import { usePortalStore } from '@/stores/portal';

const props = defineProps<{ id: string }>();
const { t, te } = useI18n();
const portal = usePortalStore();
const router = useRouter();

const request = ref<PortalMaintenanceRequest | null>(null);
const note = ref('');
const file = ref<File | null>(null);
const error = ref('');
const busy = ref('');

const contactId = computed(() => portal.selectedContactId);
const open = computed(() => request.value !== null && request.value.status !== 'done' && request.value.status !== 'rejected');
const photoSrc = (documentId: string) => `${API_BASE}/api/portal/maintenance/${props.id}/photos/${documentId}?contactId=${contactId.value ?? ''}`;
const dateTime = (iso: string) => new Date(iso).toLocaleString('mk-MK', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const message = (e: unknown) => {
  const code = (e as { code?: string }).code ?? 'generic';
  return te(`maintenance.errors.${code}`) ? t(`maintenance.errors.${code}`) : t('app.error');
};

async function load() {
  if (!contactId.value) { request.value = null; return; }
  error.value = '';
  try { request.value = await api.get<PortalMaintenanceRequest>(`/api/portal/maintenance/${props.id}`, { contactId: contactId.value }); }
  catch (e) { error.value = message(e); }
}
onMounted(load);
// The request belongs to the contact that was selected when the page loaded; switching the shell's
// contact makes it somebody else's, so the page steps back to the list (mirrors PortalAssemblyPage).
watch(() => portal.selectedContactId, () => { void router.push('/portal/maintenance'); });

async function send() {
  if (!contactId.value || !note.value.trim()) { error.value = t('maintenance.errors.validation'); return; }
  busy.value = 'note';
  try {
    request.value = await api.post<PortalMaintenanceRequest>(`/api/portal/maintenance/${props.id}/events`, { contactId: contactId.value, note: note.value.trim() });
    note.value = '';
  } catch (e) { error.value = message(e); } finally { busy.value = ''; }
}

function onFile(e: Event) { file.value = (e.target as HTMLInputElement).files?.[0] ?? null; }

async function addPhoto() {
  if (!contactId.value) return;
  if (!file.value) { error.value = t('maintenance.errors.file_required'); return; }
  busy.value = 'photo';
  try {
    const fd = new FormData();
    fd.append('contactId', contactId.value);
    fd.append('file', file.value, file.value.name);
    request.value = await api.upload<PortalMaintenanceRequest>(`/api/portal/maintenance/${props.id}/photos`, fd);
    file.value = null;
  } catch (e) { error.value = message(e); } finally { busy.value = ''; }
}
</script>
<template>
  <div v-if="request">
    <RouterLink to="/portal/maintenance" class="text-sm text-emerald-700 underline">{{ t('portal.back') }}</RouterLink>
    <h1 class="mb-1 mt-2 text-2xl font-semibold">{{ request.title }}</h1>
    <p class="mb-4 text-sm text-slate-600">
      {{ request.buildingName }}<template v-if="request.unitLabel"> · {{ request.unitLabel }}</template> ·
      {{ t(`maintenance.categories.${request.category}`) }} ·
      <span data-test="portal-maintenance-status">{{ t(`maintenance.statuses.${request.status}`) }}</span>
    </p>
    <p v-if="error" class="mb-2 text-sm text-red-600" data-test="portal-page-error">{{ error }}</p>
    <p class="mb-6 whitespace-pre-line text-sm">{{ request.description }}</p>

    <section class="mb-6">
      <h2 class="mb-2 font-semibold">{{ t('portal.maintenancePhotos') }}</h2>
      <div class="mb-3 flex flex-wrap gap-3">
        <img v-for="p in request.photos" :key="p.documentId" :src="photoSrc(p.documentId)" :alt="p.fileName"
          class="h-28 w-28 rounded-lg object-cover" data-test="portal-maintenance-photo" />
        <p v-if="request.photos.length === 0" class="text-sm text-slate-500">{{ t('app.empty') }}</p>
      </div>
      <div v-if="open" class="flex items-end gap-3">
        <input type="file" class="text-sm" accept="image/png,image/jpeg" data-test="portal-maintenance-photo-file" @change="onFile" />
        <AppButton type="button" :loading="busy === 'photo'" data-test="portal-maintenance-add-photo" @click="addPhoto">{{ t('portal.maintenanceAddPhoto') }}</AppButton>
      </div>
    </section>

    <section>
      <h2 class="mb-2 font-semibold">{{ t('portal.maintenanceTimeline') }}</h2>
      <ol class="mb-3 space-y-2 text-sm">
        <li v-for="e in request.events" :key="e.id" class="rounded-lg bg-white p-2 shadow-sm" data-test="portal-maintenance-event">
          <span class="font-medium">{{ t(`maintenance.eventKinds.${e.kind}`) }}</span>
          <span v-if="e.toStatus" class="text-slate-600"> → {{ t(`maintenance.statuses.${e.toStatus}`) }}</span>
          <span class="ml-2 text-xs text-slate-500">{{ e.authorName }} · {{ dateTime(e.createdAt) }}</span>
          <p v-if="e.note" class="whitespace-pre-line">{{ e.note }}</p>
        </li>
      </ol>
      <form v-if="open" class="flex items-end gap-3" @submit.prevent="send">
        <AppInput v-model="note" :label="t('portal.maintenanceNote')" data-test="portal-maintenance-note" />
        <AppButton type="button" :loading="busy === 'note'" data-test="portal-maintenance-send" @click="send">{{ t('portal.maintenanceAddNote') }}</AppButton>
      </form>
      <p v-else class="text-sm text-slate-500">{{ t('portal.maintenanceClosed') }}</p>
    </section>
  </div>
  <p v-else-if="error" class="text-sm text-red-600" data-test="portal-page-error">{{ error }}</p>
  <p v-else>{{ t('app.loading') }}</p>
</template>
