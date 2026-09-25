<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import type { NotificationRow } from '@/api/types';
import { useNotifications, type BellScope } from '@/composables/useNotifications';
import { disablePush, enablePush, pushState, type PushState } from '@/portal/push';
import { formatDateTime } from '@/utils/money';

const props = defineProps<{ scope: BellScope }>();
const { t } = useI18n();
const router = useRouter();
const bell = useNotifications(props.scope);
const root = ref<HTMLElement | null>(null);
const open = ref(false);
const push = ref<PushState>('unsupported');
const busy = ref(false);
const error = ref('');

onMounted(async () => {
  bell.start();
  if (props.scope === 'portal') push.value = await pushState();
  document.addEventListener('click', onOutsideClick);
  document.addEventListener('keydown', onKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onOutsideClick);
  document.removeEventListener('keydown', onKeydown);
});

/** A tap anywhere outside the bell and its panel closes it — not just a second tap on the bell. */
function onOutsideClick(e: MouseEvent) {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false;
}
function onKeydown(e: KeyboardEvent) {
  if (open.value && e.key === 'Escape') open.value = false;
}

async function openRow(row: NotificationRow) {
  open.value = false;
  error.value = '';
  if (!row.readAt) {
    try { await bell.markRead(row.id); } catch { error.value = t('app.error'); }
  }
  // Navigate regardless: a failed "mark read" must not also trap the tap into doing nothing.
  if (row.link) await router.push(row.link);
}

async function markAllRead() {
  error.value = '';
  try { await bell.markAllRead(); } catch { error.value = t('app.error'); }
}

/** Permission is requested here, from the click itself — never on mount. */
async function togglePush() {
  busy.value = true;
  error.value = '';
  try {
    if (push.value === 'on') { await disablePush(); push.value = 'off'; }
    else push.value = await enablePush();
  } catch {
    error.value = t('app.error');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div ref="root" class="relative">
    <button class="relative rounded-md px-2 py-1 text-slate-600 hover:bg-slate-100" data-test="notification-bell"
      :aria-label="t('notifications.title')" :aria-expanded="open" @click="open = !open">
      <span aria-hidden="true">🔔</span>
      <span v-if="bell.unread.value > 0" data-test="notification-count"
        class="absolute -right-1 -top-1 rounded-full bg-red-600 px-1.5 text-xs font-medium text-white">{{ bell.unread.value }}</span>
    </button>

    <div v-if="open" data-test="notification-panel"
      class="absolute right-0 z-20 mt-2 w-80 rounded-md border border-slate-200 bg-white shadow-lg">
      <div class="flex items-center justify-between border-b border-slate-200 px-3 py-2">
        <span class="text-sm font-medium">{{ t('notifications.title') }}</span>
        <button class="text-xs text-slate-600 underline" data-test="notification-mark-all" @click="markAllRead()">{{ t('notifications.markAllRead') }}</button>
      </div>

      <p v-if="error" class="px-3 py-2 text-xs text-red-600" data-test="error">{{ error }}</p>

      <div v-if="scope === 'portal'" class="flex items-center justify-between border-b border-slate-200 px-3 py-2 text-xs">
        <span class="text-slate-600" data-test="notification-push-state">{{ t(`notifications.push.${push}`) }}</span>
        <button v-if="push === 'on' || push === 'off'" class="text-emerald-700 underline" data-test="notification-push-toggle" :disabled="busy" @click="togglePush()">
          {{ push === 'on' ? t('notifications.push.disable') : t('notifications.push.enable') }}
        </button>
      </div>

      <p v-if="bell.rows.value.length === 0" class="px-3 py-4 text-sm text-slate-500" data-test="notification-empty">{{ t('notifications.empty') }}</p>
      <ul v-else class="max-h-96 overflow-y-auto">
        <li v-for="row in bell.rows.value" :key="row.id">
          <button class="block w-full px-3 py-2 text-left hover:bg-slate-50" :class="row.readAt ? '' : 'bg-emerald-50/60'"
            data-test="notification-item" @click="openRow(row)">
            <span class="block text-sm font-medium text-slate-900">{{ row.title }}</span>
            <span v-if="row.body" class="block text-xs text-slate-600">{{ row.body }}</span>
            <span class="block text-xs text-slate-400">{{ formatDateTime(row.createdAt) }}</span>
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>
