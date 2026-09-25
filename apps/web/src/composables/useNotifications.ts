import { onScopeDispose, ref, type Ref } from 'vue';
import { api } from '@/api/client';
import type { NotificationList, NotificationRow } from '@/api/types';

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
  const rows = ref<NotificationRow[]>([]);
  const unread = ref(0);
  let timer: ReturnType<typeof setInterval> | null = null;

  async function refresh() {
    try {
      const res = await api.get<NotificationList>(base);
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
    await api.post(`${base}/read-all`);
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

  onScopeDispose(stop);
  return { rows, unread, refresh, markRead, markAllRead, start, stop };
}
