import { type Db, schema } from '@domar/db';
import { MAINTENANCE_STATUSES, can, canTransition, type MaintenanceCapability, type MaintenanceRole, type MaintenanceStatus } from '@domar/domain';
import { and, asc, count, desc, eq, exists, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { writeAudit } from '../../audit.js';
import { AppError, badRequest, conflict, notFound } from '../../errors.js';
import type { TenantContext, UserRole } from '../../tenant-context.js';
import { getBuilding } from '../buildings/repo.js';
import { stripUndefined } from '../common.js';
import { assertSupplierInTenant } from '../suppliers/repo.js';
import type { MaintenanceAssignInput, MaintenanceCreateInput, MaintenanceEventInput, MaintenanceListQuery, MaintenancePatchInput, MaintenanceStatusInput } from './schema.js';

export const MR = schema.maintenanceRequests;
const ME = schema.maintenanceEvents;
const MP = schema.maintenancePhotos;
const U = schema.units; const C = schema.contacts; const S = schema.suppliers; const USR = schema.users; const D = schema.documents;

const reporterUser = alias(USR, 'reporter_user');
const assigneeUser = alias(USR, 'assignee_user');
const authorUser = alias(USR, 'author_user');
const authorContact = alias(C, 'author_contact');
const uploaderUser = alias(USR, 'uploader_user');
const uploaderContact = alias(C, 'uploader_contact');

export type MaintenanceRow = typeof MR.$inferSelect;

export const fullName = (first: string | null, last: string | null) => `${first ?? ''} ${last ?? ''}`.trim();

/** Only a user of this tenant, active, and in a role that can actually be given work (spec §8, §10). */
const ASSIGNABLE_ROLES: UserRole[] = ['owner', 'accountant', 'technician'];

/**
 * Spec §10: a technician sees their own queue and nothing else. This one clause is added to every
 * read and every write of the table, so there is no path that forgets it (plan addendum 7).
 */
function scope(ctx: TenantContext) {
  if (ctx.role !== 'technician') return [];
  // A technician always signs in, so `userId` is set; the guard keeps the uuid comparison from ever
  // being handed an empty string, which Postgres would reject rather than treat as "no rows".
  return [ctx.userId ? eq(MR.assigneeUserId, ctx.userId) : sql`false`];
}

/** The capability the role has to hold to move a request to `to`. */
function capabilityFor(to: MaintenanceStatus, hasCost: boolean): MaintenanceCapability {
  if (to === 'triaged') return 'triage';
  if (to === 'rejected') return 'reject';
  if (to === 'in_progress') return 'progress';
  return hasCost ? 'close_with_cost' : 'close';
}

/** A status an owner reads on their card is a status they read in their timeline (addendum 11). */
const OWNER_VISIBLE_STATUSES: MaintenanceStatus[] = ['triaged', 'assigned', 'in_progress', 'done', 'rejected'];

async function assertUnitInBuilding(db: Db, ctx: TenantContext, buildingId: string, unitId: string | null | undefined): Promise<void> {
  if (!unitId) return;
  const [row] = await db.select({ id: U.id }).from(U)
    .where(and(eq(U.tenantId, ctx.tenantId), eq(U.buildingId, buildingId), eq(U.id, unitId))).limit(1);
  if (!row) throw badRequest('invalid_reference', 'unitId does not belong to this building');
}

async function assertAssignee(db: Db, ctx: TenantContext, userId: string) {
  const [row] = await db.select({ id: USR.id, role: USR.role, isActive: USR.isActive, firstName: USR.firstName, lastName: USR.lastName })
    .from(USR).where(and(eq(USR.tenantId, ctx.tenantId), eq(USR.id, userId))).limit(1);
  if (!row || !row.isActive || !ASSIGNABLE_ROLES.includes(row.role)) {
    throw badRequest('invalid_reference', 'assigneeUserId must be an active technician, accountant or owner of this organization');
  }
  return row;
}

/** The raw row, tenant-scoped and technician-scoped. Another tenant's id and somebody else's request are both 404. */
export async function getRequestRow(db: Db, ctx: TenantContext, id: string): Promise<MaintenanceRow> {
  const [row] = await db.select().from(MR).where(and(eq(MR.tenantId, ctx.tenantId), eq(MR.id, id), ...scope(ctx))).limit(1);
  if (!row) throw notFound('Maintenance request');
  return row;
}

/**
 * The feed's own guard. `requestPhotos` and `requestEvents` are exported, and the owner portal will
 * call them for a contact, so neither may lean on its caller having checked anything first: the
 * request itself has to be reachable — same tenant, same technician scope, and, when a contact is
 * asking, reported by that very contact. A request outside the caller's reach yields no rows.
 */
function visibleRequest(db: Db, ctx: TenantContext, requestId: string, reporterContactId?: string | null | undefined) {
  return exists(db.select({ one: sql`1` }).from(MR).where(and(
    eq(MR.tenantId, ctx.tenantId), eq(MR.id, requestId), ...scope(ctx),
    ...(reporterContactId ? [eq(MR.reportedByContactId, reporterContactId)] : []),
  )));
}

/** Who is reading a feed, when it is not a signed-in member of staff. */
export interface FeedScope {
  /** The portal's caller: the feed is readable only if this contact reported the request. */
  reporterContactId?: string | null | undefined;
}

/**
 * Claim-first, exactly like `claimAssembly`: the status is both the guard and the thing that moves,
 * so two managers closing at once produce one close, one 409 — and one expense (plan addendum 4).
 */
export async function claimRequest(tx: Db, ctx: TenantContext, id: string, allowed: MaintenanceStatus[]): Promise<MaintenanceRow> {
  const [row] = await tx.update(MR).set({ updatedAt: new Date() })
    .where(and(eq(MR.tenantId, ctx.tenantId), eq(MR.id, id), inArray(MR.status, allowed), ...scope(ctx))).returning();
  if (!row) {
    await getRequestRow(tx, ctx, id); // 404 across tenants and for a technician who is not assigned
    throw conflict('status_locked', `Only a request with status ${allowed.join(' or ')} can be changed this way`);
  }
  return row;
}

export async function recordEvent(tx: Db, ctx: TenantContext, e: {
  requestId: string;
  kind: typeof ME.$inferInsert['kind'];
  fromStatus?: MaintenanceStatus | null;
  toStatus?: MaintenanceStatus | null;
  note?: string;
  visibility?: typeof ME.$inferInsert['visibility'];
  authorContactId?: string | null;
}): Promise<void> {
  await tx.insert(ME).values({
    tenantId: ctx.tenantId,
    maintenanceRequestId: e.requestId,
    kind: e.kind,
    fromStatus: e.fromStatus ?? null,
    toStatus: e.toStatus ?? null,
    note: e.note ?? '',
    visibility: e.visibility ?? 'internal',
    // Exactly one author, or none: the portal passes a contact, staff routes pass neither and let
    // `ctx.userId` sign the row (the table's check is `<= 1`, so a job with no user is legal too).
    authorUserId: e.authorContactId ? null : ctx.userId,
    authorContactId: e.authorContactId ?? null,
  });
}

/** The subquery spells its table and column out: drizzle renders single-table selects unqualified. */
export const PHOTO_COUNT = sql<number>`(select count(*) from "maintenance_photos" p where p.maintenance_request_id = "maintenance_requests"."id")`.mapWith(Number);

const selection = {
  r: MR,
  unitLabel: U.label,
  reporterFirst: reporterUser.firstName, reporterLast: reporterUser.lastName,
  contactFirst: C.firstName, contactLast: C.lastName,
  assigneeFirst: assigneeUser.firstName, assigneeLast: assigneeUser.lastName,
  supplierName: S.name,
  photoCount: PHOTO_COUNT,
};

/** What `baseQuery` yields. Written out rather than inferred so `toRow` needs no cast. */
interface Joined {
  r: MaintenanceRow;
  unitLabel: string | null;
  reporterFirst: string | null; reporterLast: string | null;
  contactFirst: string | null; contactLast: string | null;
  assigneeFirst: string | null; assigneeLast: string | null;
  supplierName: string | null;
  photoCount: number;
}

function toRow(r: Joined) {
  const owner = r.r.reportedByContactId !== null;
  return {
    id: r.r.id, buildingId: r.r.buildingId, unitId: r.r.unitId, unitLabel: r.unitLabel,
    title: r.r.title, category: r.r.category, priority: r.r.priority, status: r.r.status,
    reporterName: owner ? fullName(r.contactFirst, r.contactLast) : fullName(r.reporterFirst, r.reporterLast),
    reporterKind: owner ? ('owner' as const) : ('manager' as const),
    assigneeUserId: r.r.assigneeUserId, assigneeName: r.r.assigneeUserId ? fullName(r.assigneeFirst, r.assigneeLast) : null,
    supplierId: r.r.supplierId, supplierName: r.supplierName,
    fund: r.r.fund, costMinor: r.r.costMinor, expenseId: r.r.expenseId,
    photoCount: r.photoCount,
    closedAt: r.r.closedAt, createdAt: r.r.createdAt, updatedAt: r.r.updatedAt,
  };
}

function baseQuery(db: Db) {
  return db.select(selection).from(MR)
    .leftJoin(U, and(eq(U.id, MR.unitId), eq(U.tenantId, MR.tenantId)))
    .leftJoin(reporterUser, and(eq(reporterUser.id, MR.reportedByUserId), eq(reporterUser.tenantId, MR.tenantId)))
    .leftJoin(C, and(eq(C.id, MR.reportedByContactId), eq(C.tenantId, MR.tenantId)))
    .leftJoin(assigneeUser, and(eq(assigneeUser.id, MR.assigneeUserId), eq(assigneeUser.tenantId, MR.tenantId)))
    .leftJoin(S, and(eq(S.id, MR.supplierId), eq(S.tenantId, MR.tenantId)));
}

export async function listRequests(db: Db, ctx: TenantContext, buildingId: string, q: MaintenanceListQuery) {
  await getBuilding(db, ctx, buildingId); // 404 across tenants, before anything is read
  const where = and(eq(MR.tenantId, ctx.tenantId), eq(MR.buildingId, buildingId), ...scope(ctx),
    ...(q.status ? [eq(MR.status, q.status)] : []),
    ...(q.category ? [eq(MR.category, q.category)] : []),
    ...(q.priority ? [eq(MR.priority, q.priority)] : []),
    ...(q.assigneeUserId ? [eq(MR.assigneeUserId, q.assigneeUserId)] : []));
  // The count reads `maintenance_requests` alone: every join in `baseQuery` is a left join on a
  // unique id, so none of them can change how many rows the page is cut from.
  const [rows, totalRows] = await Promise.all([
    baseQuery(db).where(where).orderBy(desc(MR.createdAt), desc(MR.id)).limit(q.pageSize).offset((q.page - 1) * q.pageSize),
    db.select({ total: count() }).from(MR).where(where),
  ]);
  return { rows: rows.map((r) => toRow(r)), total: Number(totalRows[0]?.total ?? 0) };
}

export async function requestPhotos(db: Db, ctx: TenantContext, requestId: string, opts: FeedScope = {}) {
  const rows = await db.select({
    documentId: MP.documentId, title: D.title, fileName: D.fileName, mime: D.mime, sizeBytes: D.sizeBytes,
    createdAt: MP.createdAt,
    userFirst: uploaderUser.firstName, userLast: uploaderUser.lastName,
    contactFirst: uploaderContact.firstName, contactLast: uploaderContact.lastName,
  }).from(MP)
    .innerJoin(D, and(eq(D.id, MP.documentId), eq(D.tenantId, MP.tenantId)))
    .leftJoin(uploaderUser, and(eq(uploaderUser.id, MP.uploadedByUserId), eq(uploaderUser.tenantId, MP.tenantId)))
    .leftJoin(uploaderContact, and(eq(uploaderContact.id, MP.uploadedByContactId), eq(uploaderContact.tenantId, MP.tenantId)))
    .where(and(eq(MP.tenantId, ctx.tenantId), eq(MP.maintenanceRequestId, requestId),
      visibleRequest(db, ctx, requestId, opts.reporterContactId)))
    .orderBy(asc(MP.createdAt), asc(MP.id));
  return rows.map((r) => ({
    documentId: r.documentId, title: r.title, fileName: r.fileName, mime: r.mime, sizeBytes: r.sizeBytes,
    uploadedByName: r.contactFirst !== null || r.contactLast !== null
      ? fullName(r.contactFirst, r.contactLast)
      : fullName(r.userFirst, r.userLast),
    createdAt: r.createdAt,
  }));
}

export async function requestEvents(db: Db, ctx: TenantContext, requestId: string, opts: FeedScope & { onlyOwnerVisible?: boolean } = {}) {
  const rows = await db.select({
    e: ME,
    userFirst: authorUser.firstName, userLast: authorUser.lastName,
    contactFirst: authorContact.firstName, contactLast: authorContact.lastName,
  }).from(ME)
    .leftJoin(authorUser, and(eq(authorUser.id, ME.authorUserId), eq(authorUser.tenantId, ME.tenantId)))
    .leftJoin(authorContact, and(eq(authorContact.id, ME.authorContactId), eq(authorContact.tenantId, ME.tenantId)))
    .where(and(eq(ME.tenantId, ctx.tenantId), eq(ME.maintenanceRequestId, requestId),
      visibleRequest(db, ctx, requestId, opts.reporterContactId),
      ...(opts.onlyOwnerVisible ? [eq(ME.visibility, 'owner')] : [])))
    .orderBy(asc(ME.createdAt), asc(ME.id));
  return rows.map((r) => ({
    id: r.e.id, kind: r.e.kind, fromStatus: r.e.fromStatus, toStatus: r.e.toStatus,
    note: r.e.note, visibility: r.e.visibility,
    authorName: r.e.authorContactId ? fullName(r.contactFirst, r.contactLast) : fullName(r.userFirst, r.userLast),
    authorKind: r.e.authorContactId ? ('owner' as const) : r.e.authorUserId ? ('manager' as const) : ('system' as const),
    createdAt: r.e.createdAt,
  }));
}

export async function getRequest(db: Db, ctx: TenantContext, id: string) {
  // One read: `baseQuery` carries the same tenant clause and the same technician scope as
  // `getRequestRow`, so the 404 across tenants and outside a technician's queue is this `if`.
  const [row] = await baseQuery(db).where(and(eq(MR.tenantId, ctx.tenantId), eq(MR.id, id), ...scope(ctx))).limit(1);
  if (!row) throw notFound('Maintenance request');
  const [photos, events] = await Promise.all([requestPhotos(db, ctx, id), requestEvents(db, ctx, id)]);
  return { ...toRow(row), description: row.r.description, photos, events };
}

export async function createRequest(db: Db, ctx: TenantContext, buildingId: string, input: MaintenanceCreateInput) {
  return db.transaction(async (tx) => {
    await getBuilding(tx, ctx, buildingId);
    await assertUnitInBuilding(tx, ctx, buildingId, input.unitId);
    const [row] = await tx.insert(MR).values({
      tenantId: ctx.tenantId, buildingId, unitId: input.unitId ?? null,
      title: input.title, description: input.description, category: input.category, priority: input.priority,
      reportedByUserId: ctx.userId, reportedByContactId: null,
    }).returning();
    await recordEvent(tx, ctx, { requestId: row!.id, kind: 'created', toStatus: 'new', note: input.title });
    await writeAudit(tx, ctx, { action: 'maintenance.create', entityType: 'maintenance_request', entityId: row!.id, after: row });
    return getRequest(tx, ctx, row!.id);
  });
}

/** Open requests only: a closed one is evidence of what was done, not a draft (plan addendum 2). */
export async function updateRequest(db: Db, ctx: TenantContext, id: string, patch: MaintenancePatchInput) {
  return db.transaction(async (tx) => {
    const before = await claimRequest(tx, ctx, id, ['new', 'triaged', 'assigned', 'in_progress']);
    await assertUnitInBuilding(tx, ctx, before.buildingId, patch.unitId);
    const [row] = await tx.update(MR).set({ ...stripUndefined(patch), updatedAt: new Date() })
      .where(and(eq(MR.tenantId, ctx.tenantId), eq(MR.id, id))).returning();
    await writeAudit(tx, ctx, { action: 'maintenance.update', entityType: 'maintenance_request', entityId: id, before, after: row });
    return getRequest(tx, ctx, id);
  });
}

export async function setStatus(db: Db, ctx: TenantContext, id: string, input: MaintenanceStatusInput) {
  const to = input.status as MaintenanceStatus;
  const hasCost = input.cost != null;
  if (!can(ctx.role as MaintenanceRole, capabilityFor(to, hasCost))) {
    if (hasCost) throw new AppError(403, 'cost_requires_write_role', 'Only an owner or an accountant may close a request with a cost');
    throw new AppError(403, 'forbidden', 'Not allowed');
  }
  // Explicitly `undefined`, not falsy: `{ cost: null }` is a decision, a missing key is not (addendum 5).
  if (to === 'done' && input.cost === undefined) {
    throw badRequest('cost_decision_required', 'Closing a request requires either a cost or an explicit null');
  }
  const froms = MAINTENANCE_STATUSES.filter((s) => canTransition(s, to));
  return db.transaction(async (tx) => {
    const before = await claimRequest(tx, ctx, id, [...froms]);
    const [row] = await tx.update(MR).set({ status: to, updatedAt: new Date(), ...(to === 'done' ? { closedAt: new Date() } : {}) })
      .where(and(eq(MR.tenantId, ctx.tenantId), eq(MR.id, id))).returning();
    await recordEvent(tx, ctx, {
      requestId: id, kind: 'status_changed', fromStatus: before.status, toStatus: to, note: input.note ?? '',
      visibility: input.visibility ?? (OWNER_VISIBLE_STATUSES.includes(to) ? 'owner' : 'internal'),
    });
    await writeAudit(tx, ctx, { action: 'maintenance.status', entityType: 'maintenance_request', entityId: id, before, after: row });
    return getRequest(tx, ctx, id);
  });
}

/**
 * `new|triaged` become `assigned`; `assigned|in_progress` keep their status and only change hands,
 * because a technician who has already started is not back at the beginning (plan addendum 3).
 */
export async function assignRequest(db: Db, ctx: TenantContext, id: string, input: MaintenanceAssignInput) {
  return db.transaction(async (tx) => {
    const assignee = await assertAssignee(tx, ctx, input.assigneeUserId);
    await assertSupplierInTenant(tx, ctx, input.supplierId);
    const before = await claimRequest(tx, ctx, id, ['new', 'triaged', 'assigned', 'in_progress']);
    // `claimRequest` already refused a terminal request, so this is the whole choice there is.
    const to: MaintenanceStatus = before.status === 'in_progress' ? 'in_progress' : 'assigned';
    const [row] = await tx.update(MR).set({
      assigneeUserId: input.assigneeUserId, status: to, updatedAt: new Date(),
      ...(input.supplierId !== undefined ? { supplierId: input.supplierId } : {}),
    }).where(and(eq(MR.tenantId, ctx.tenantId), eq(MR.id, id))).returning();
    await recordEvent(tx, ctx, {
      requestId: id, kind: 'assigned', fromStatus: before.status, toStatus: to,
      note: input.note ?? fullName(assignee.firstName, assignee.lastName), visibility: 'owner',
    });
    await writeAudit(tx, ctx, { action: 'maintenance.assign', entityType: 'maintenance_request', entityId: id, before, after: row });
    return getRequest(tx, ctx, id);
  });
}

export async function addEvent(db: Db, ctx: TenantContext, id: string, input: MaintenanceEventInput) {
  return db.transaction(async (tx) => {
    const row = await getRequestRow(tx, ctx, id);
    await recordEvent(tx, ctx, { requestId: row.id, kind: 'comment', note: input.note, visibility: input.visibility });
    await writeAudit(tx, ctx, { action: 'maintenance.event', entityType: 'maintenance_request', entityId: id, after: { note: input.note, visibility: input.visibility } });
    return getRequest(tx, ctx, id);
  });
}
