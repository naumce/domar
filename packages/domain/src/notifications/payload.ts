/**
 * Spec §11: "Notifications never include amounts in push payloads (title + link only); details load
 * in the app." The rule is a whitelist rather than a redaction, so a column added to `notifications`
 * later cannot reach a phone by being forgotten.
 */
export const NOTIFICATION_KINDS = [
  'invoice_published', 'reminder_created', 'assembly_invited', 'assembly_voting_opened',
  'maintenance_status', 'maintenance_request_created', 'delivery_failed',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface PushPayload {
  id: string;
  title: string;
  /** An in-app path (`/portal/invoices/…`), resolved by the service worker against its own origin. */
  link: string;
}

export function pushPayload(n: { id: string; title: string; link: string }): PushPayload {
  return { id: n.id, title: n.title, link: n.link };
}
