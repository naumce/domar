import { api } from '@/api/client';

/**
 * `unknown` is distinct from every other state: it means the call itself failed (offline, a 401,
 * a flaky network) rather than telling us anything about whether push is actually on or off. The
 * bell in Task 7 renders it as "couldn't tell right now", never as `off`.
 */
export type PushState = 'unsupported' | 'unconfigured' | 'denied' | 'off' | 'on' | 'unknown';

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

/**
 * `navigator.serviceWorker.ready` only ever settles once a client is under an *active,
 * controlling* worker in scope — on a page outside `/portal/`, or before that first activation,
 * it never resolves and every caller hangs silently. A registration is enough for every
 * `pushManager` operation used here, so look one up (or create it) instead of waiting to be
 * controlled by it.
 */
async function activeRegistration(): Promise<ServiceWorkerRegistration | null> {
  const existing = await navigator.serviceWorker.getRegistration(SCOPE);
  return existing ?? (await registerPortalWorker());
}

/** The base64url VAPID key as the bytes `PushManager.subscribe` wants. No `Buffer` in a browser. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/** A subscription made against a since-rotated VAPID key is not reusable: it must be remade. */
function sameApplicationServerKey(subscription: PushSubscription, key: string): boolean {
  const existing = subscription.options?.applicationServerKey;
  if (!existing) return false;
  const target = urlBase64ToUint8Array(key);
  const bytes = new Uint8Array(existing);
  return bytes.length === target.length && bytes.every((b, i) => b === target[i]);
}

async function serverKey(): Promise<string | null> {
  const { publicKey } = await api.get<{ publicKey: string | null }>('/api/portal/push/key');
  return publicKey;
}

/**
 * Never throws: its whole job is to name a state for the bell to render, so a failed server call
 * or a registration that cannot be obtained resolves to `'unknown'` rather than rejecting.
 */
export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  try {
    if (!(await serverKey())) return 'unconfigured';
    if (Notification.permission === 'denied') return 'denied';
    const registration = await activeRegistration();
    if (!registration) return 'unknown';
    return (await registration.pushManager.getSubscription()) ? 'on' : 'off';
  } catch {
    return 'unknown';
  }
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
  const registration = await activeRegistration();
  if (!registration) return 'unsupported';

  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameApplicationServerKey(subscription, key)) {
    // The server's VAPID key rotated since this browser last subscribed: the old subscription is
    // dead weight the push service will only ever reject. Drop it and subscribe fresh.
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
  });

  const json = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  const endpoint = json.endpoint ?? subscription.endpoint;
  const { p256dh, auth } = json.keys ?? {};
  if (!endpoint || !p256dh || !auth) {
    // The server's schema requires both keys non-empty; posting `''` would just be rejected a
    // round-trip later. Fail here instead, and don't leave the browser subscribed to a
    // registration the server was never told about.
    await subscription.unsubscribe().catch(() => {});
    throw new Error('Push subscription is missing its endpoint or encryption keys.');
  }
  try {
    await api.post('/api/portal/push/subscribe', { endpoint, p256dh, auth, userAgent: navigator.userAgent.slice(0, 500) });
  } catch (err) {
    // The server never learned about this subscription — don't leave the browser subscribed
    // behind its back, or `pushState()` would report `'on'` forever while the server has nothing.
    await subscription.unsubscribe().catch(() => {});
    throw err;
  }
  return 'on';
}

export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  const registration = await activeRegistration();
  if (!registration) return;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  await api.post('/api/portal/push/unsubscribe', { endpoint });
}
