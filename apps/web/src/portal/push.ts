import { api } from '@/api/client';

export type PushState = 'unsupported' | 'unconfigured' | 'denied' | 'off' | 'on';

/** `/portal/sw.js`, so the worker's own directory is its scope — no server header needed (addendum 10). */
const WORKER_URL = '/portal/sw.js';
const SCOPE = '/portal/';

export function pushSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator
    && typeof PushManager !== 'undefined' && typeof Notification !== 'undefined';
}

export async function registerPortalWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register(WORKER_URL, { scope: SCOPE });
  } catch {
    // A blocked worker (private mode, an http origin that is not localhost) is not an error the
    // owner can do anything about: the portal keeps working, it simply has no offline shell.
    return null;
  }
}

/** The base64url VAPID key as the bytes `PushManager.subscribe` wants. No `Buffer` in a browser. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function serverKey(): Promise<string | null> {
  const { publicKey } = await api.get<{ publicKey: string | null }>('/api/portal/push/key');
  return publicKey;
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (!(await serverKey())) return 'unconfigured';
  if (Notification.permission === 'denied') return 'denied';
  const registration = await navigator.serviceWorker.ready;
  return (await registration.pushManager.getSubscription()) ? 'on' : 'off';
}

/**
 * A push subscription is not tenant-scoped — it identifies a browser, exactly like an owner
 * session — so no contact/owner id travels with it (Task 3's `/push/subscribe` takes none).
 */
export async function enablePush(): Promise<'on' | 'denied' | 'unsupported' | 'unconfigured'> {
  if (!pushSupported()) return 'unsupported';
  const key = await serverKey();
  if (!key) return 'unconfigured';
  if (Notification.permission !== 'granted' && (await Notification.requestPermission()) !== 'granted') return 'denied';
  const registration = await navigator.serviceWorker.ready;
  const subscription = (await registration.pushManager.getSubscription())
    ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) as BufferSource }));
  const json = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  await api.post('/api/portal/push/subscribe', {
    endpoint: json.endpoint ?? subscription.endpoint,
    p256dh: json.keys?.p256dh ?? '',
    auth: json.keys?.auth ?? '',
    userAgent: navigator.userAgent.slice(0, 500),
  });
  return 'on';
}

export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  await api.post('/api/portal/push/unsubscribe', { endpoint });
}
