import { onScopeDispose, ref, watch, type Ref } from 'vue';
import { api } from '@/api/client';
import type { NotificationList, NotificationRow } from '@/api/types';
import { usePortalStore } from '@/stores/portal';

export type BellScope = 'app' | 'portal';

/** Polling, not a stream: one long-lived connection per open tab is not worth minutes of latency (addendum 8). */
const POLL_MS = 60_000;

export interface Bell {
  rows: Ref<NotificationRow[]>;
  unread: Ref<number>;
  refresh(): Promise<void>;
  markRead(id: string): Promise<void>;
  markAllRead(): Promise<void>;
  start(): void;
  stop(): void;
}

export function useNotifications(scope: BellScope): Bell {
  const base = scope === 'portal' ? '/api/portal/notifications' : '/api/notifications';
  // An owner account is cross-tenant, but every portal page is scoped to the selected link and a row
  // carries nothing to switch that selection by — so the portal bell asks for the selected link's
  // rows only, and never offers one the app would open with the wrong contact.
  const portal = scope === 'portal' ? usePortalStore() : null;
  const rows = ref<NotificationRow[]>([]);
  const unread = ref(0);
  let timer: ReturnType<typeof setInterval> | null = null;

  /** No selection yet (a first load, or an account with no link at all) means no scope to send. */
  const scoped = (path: string) => {
    const contactId = portal?.selectedContactId;
    return contactId ? `${path}?contactId=${encodeURIComponent(contactId)}` : path;
  };

  async function refresh() {
    try {
      const res = await api.get<NotificationList>(scoped(base));
      rows.value = res.rows;
      unread.value = res.unread;
    } catch {
      // A signed-out tab or a blip: the bell simply keeps what it had.
    }
  }

  async function markRead(id: string) {
    await api.post(`${base}/${id}/read`);
    await refresh();
  }

  async function markAllRead() {
    // Scoped like the listing: it clears what the bell is showing, not the other manager's rows.
    await api.post(scoped(`${base}/read-all`));
    await refresh();
  }

  function onVisible() {
    if (document.visibilityState === 'visible') void refresh();
  }

  function start() {
    void refresh();
    if (timer === null) timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, POLL_MS);
    document.addEventListener('visibilitychange', onVisible);
  }

  function stop() {
    if (timer !== null) { clearInterval(timer); timer = null; }
    document.removeEventListener('visibilitychange', onVisible);
  }

  // Switching property switches the bell with it, the same way every portal page reloads.
  if (portal) watch(() => portal.selectedContactId, () => { void refresh(); });

  onScopeDispose(stop);
  return { rows, unread, refresh, markRead, markAllRead, start, stop };
}
