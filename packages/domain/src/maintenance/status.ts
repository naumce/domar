/**
 * Spec §8, as pure data. Nothing here touches a database, a clock or a locale, so the API, the two
 * web screens and the tests all read one table instead of three copies of the same rules.
 */
export type MaintenanceStatus = 'new' | 'triaged' | 'assigned' | 'in_progress' | 'done' | 'rejected';
export type MaintenancePriority = 'low' | 'normal' | 'high' | 'urgent';
export type MaintenanceCategory = 'plumbing' | 'electrical' | 'lift' | 'heating' | 'cleaning' | 'common_area' | 'other';
/** The four `user_role` values; the capability matrix is total over them. */
export type MaintenanceRole = 'owner' | 'accountant' | 'technician' | 'readonly';
export type MaintenanceCapability =
  | 'create' | 'triage' | 'reject' | 'assign' | 'progress' | 'close' | 'close_with_cost' | 'comment' | 'photo';

/** The order the board draws its columns in, and the order the `maintenance_status` enum declares. */
export const MAINTENANCE_STATUSES: readonly MaintenanceStatus[] = ['new', 'triaged', 'assigned', 'in_progress', 'done', 'rejected'];
export const MAINTENANCE_PRIORITIES: readonly MaintenancePriority[] = ['low', 'normal', 'high', 'urgent'];
export const MAINTENANCE_CATEGORIES: readonly MaintenanceCategory[] = ['plumbing', 'electrical', 'lift', 'heating', 'cleaning', 'common_area', 'other'];
/** Closed for good: a request that was not really fixed is a new request (plan addendum 2). */
export const TERMINAL_STATUSES: readonly MaintenanceStatus[] = ['done', 'rejected'];

/**
 * Every legal edge, and no other. `new|triaged → assigned` lives here because it is part of the
 * graph; the HTTP status route nevertheless refuses `assigned` as a target, because reaching it
 * needs an assignee and that is `POST …/assign`'s job (plan addendum 3).
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<MaintenanceStatus, readonly MaintenanceStatus[]>> = {
  new: ['triaged', 'assigned', 'rejected'],
  triaged: ['assigned', 'rejected'],
  assigned: ['in_progress', 'done'],
  in_progress: ['done'],
  done: [],
  rejected: [],
};

export const MAINTENANCE_CAPABILITIES: Readonly<Record<MaintenanceRole, readonly MaintenanceCapability[]>> = {
  owner: ['create', 'triage', 'reject', 'assign', 'progress', 'close', 'close_with_cost', 'comment', 'photo'],
  accountant: ['create', 'triage', 'reject', 'assign', 'progress', 'close', 'close_with_cost', 'comment', 'photo'],
  // Spec §10: the technician's real job. `close_with_cost` is deliberately absent — booking money
  // against a building's fund is an accountant's act (plan addendum 6).
  technician: ['progress', 'close', 'comment', 'photo'],
  readonly: [],
};

export function nextStatuses(from: MaintenanceStatus): readonly MaintenanceStatus[] {
  return ALLOWED_TRANSITIONS[from];
}

export function canTransition(from: MaintenanceStatus, to: MaintenanceStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** The target when the move is legal, `null` when it is not; the API turns `null` into a 409. */
export function nextStatus(from: MaintenanceStatus, to: MaintenanceStatus): MaintenanceStatus | null {
  return canTransition(from, to) ? to : null;
}

export function isTerminal(status: MaintenanceStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function can(role: MaintenanceRole, capability: MaintenanceCapability): boolean {
  return MAINTENANCE_CAPABILITIES[role].includes(capability);
}
