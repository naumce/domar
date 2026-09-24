<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { PortalInvite, PortalStatus } from '@/api/types';
import AppButton from '@/components/ui/AppButton.vue';

const props = defineProps<{ contactId: string }>();
const { t } = useI18n();
const status = ref<PortalStatus | null>(null);
const invite = ref<PortalInvite | null>(null);
const error = ref(''); const busy = ref(false); const copied = ref(false);

async function loadStatus() {
  try { status.value = await api.get<PortalStatus>(`/api/contacts/${props.contactId}/portal-status`); }
  catch { error.value = t('app.error'); }
}
onMounted(loadStatus);

async function issue() {
  busy.value = true; error.value = ''; copied.value = false;
  try {
    // Shown exactly once: the server keeps only a sha256 hash, so this is the manager's only chance.
    invite.value = await api.post<PortalInvite>(`/api/contacts/${props.contactId}/portal-invite`, {});
    await loadStatus();
  } catch { error.value = t('app.error'); } finally { busy.value = false; }
}

async function unlink() {
  // One contact is one owner login, so a new code is useless while the wrong account holds the link.
  if (!window.confirm(t('contacts.portalAccess.confirmUnlink'))) return;
  busy.value = true; error.value = ''; invite.value = null;
  try {
    await api.del(`/api/contacts/${props.contactId}/portal-link`);
    await loadStatus();
  } catch { error.value = t('app.error'); } finally { busy.value = false; }
}

async function copy() {
  if (!invite.value) return;
  try { await navigator.clipboard?.writeText(invite.value.code); copied.value = true; } catch { copied.value = false; }
}

const date = (d: string | undefined) => (d ? new Date(d).toLocaleDateString('mk-MK') : '—');
</script>
<template>
  <section class="mb-4 max-w-xl rounded-xl bg-white p-4 shadow-sm">
    <div class="mb-2 flex items-center justify-between">
      <h2 class="font-medium">{{ t('contacts.portalAccess.title') }}</h2>
      <AppButton v-if="status?.status === 'linked'" variant="secondary" :loading="busy" data-test="portal-unlink" @click="unlink">
        {{ t('contacts.portalAccess.unlink') }}
      </AppButton>
      <AppButton v-else variant="secondary" :loading="busy" data-test="portal-issue" @click="issue">
        {{ status?.status === 'invited' ? t('contacts.portalAccess.reissue') : t('contacts.portalAccess.issue') }}
      </AppButton>
    </div>
    <p class="text-sm text-slate-600">
      {{ t('contacts.portalAccess.status') }}:
      <span class="font-medium text-slate-800" data-test="portal-status">{{ t(`contacts.portalAccess.${status?.status ?? 'none'}`) }}</span>
      <span v-if="status?.expiresAt"> · {{ t('contacts.portalAccess.expires') }} <span data-test="portal-expires">{{ date(status.expiresAt) }}</span></span>
      <span v-if="status?.linkedAt"> · {{ t('contacts.portalAccess.linkedAt') }} {{ date(status.linkedAt) }}</span>
    </p>
    <p v-if="error" class="mt-2 text-sm text-red-600" data-test="portal-access-error">{{ error }}</p>
    <div v-if="invite" class="mt-3 rounded-lg bg-emerald-50 p-3 text-sm">
      <div class="font-medium">{{ t('contacts.portalAccess.code') }}</div>
      <code class="mt-1 block text-lg font-semibold tracking-wider" data-test="portal-issued-code">{{ invite.code }}</code>
      <div class="mt-1 text-slate-600">{{ t('contacts.portalAccess.hint') }}</div>
      <div class="mt-1 text-slate-600" data-test="portal-code-emailed">{{ invite.emailed ? t('contacts.portalAccess.emailed') : t('contacts.portalAccess.notEmailed') }}</div>
      <AppButton variant="secondary" class="mt-2" data-test="portal-code-copy" @click="copy">{{ t('contacts.portalAccess.copy') }}</AppButton>
      <span v-if="copied" class="ml-2 text-emerald-700" data-test="portal-code-copied">{{ t('contacts.portalAccess.copied') }}</span>
      <AppButton variant="secondary" class="ml-2 mt-2" data-test="portal-code-dismiss" @click="invite = null">{{ t('contacts.portalAccess.dismiss') }}</AppButton>
    </div>
  </section>
</template>
