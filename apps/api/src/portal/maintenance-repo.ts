import { type Db, schema } from '@domar/db';
import { isTerminal, type MaintenanceCategory, type MaintenancePriority } from '@domar/domain';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { writeAudit } from '../audit.js';
import type { DocumentStore } from '../documents/store.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { notifyStaff } from '../notifications/repo.js';
import { addPhoto, photoFile, type NewPhoto } from '../resources/maintenance/photos.js';
import { MR, PHOTO_COUNT, recordEvent, requestEvents, requestPhotos } from '../resources/maintenance/repo.js';
import type { TenantContext } from '../tenant-context.js';
import type { PortalContext } from './context.js';
import { assertOwnsUnitIn, resolveLink } from './repo.js';

const B = schema.buildings; const U = schema.units;

/**
 * Spec §8's portal half. An owner sees the requests **they** reported, never the building's whole
 * board: a neighbour's free-text description is not theirs to read (plan addendum 10). Everything
 * here is `reported_by_contact_id = contactId`, and anything else is a 404.
 */
async function ownedRequest(db: Db, ctx: TenantContext, contactId: string, id: string) {
  const [row] = await db.select().from(MR)
    .where(and(eq(MR.tenantId, ctx.tenantId), eq(MR.id, id), eq(MR.reportedByContactId, contactId))).limit(1);
  if (!row) throw notFound('Maintenance request');
  // The contact must still own a unit in that building: a link that lapsed is not a key.
  await assertOwnsUnitIn(db, ctx, contactId, row.buildingId);
  return row;
}

/** Nothing about the money and nothing about internal handling reaches this shape. */
function toPortalRow(row: typeof MR.$inferSelect, buildingName: string, unitLabel: string | null, photoCount: number) {
  return {
    id: row.id, buildingId: row.buildingId, buildingName, unitLabel,
    title: row.title, category: row.category, priority: row.priority, status: row.status,
    photoCount, closedAt: row.closedAt, createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

/**
 * The two feeds are asked for as the contact, not as the tenant: `requestPhotos` and `requestEvents`
 * carry their own `reported_by_contact_id` guard, so a request that is not this owner's yields no
 * rows even if a caller above ever forgot to check (Task 3's fix round).
 */
async function detail(db: Db, ctx: TenantContext, contactId: string, row: typeof MR.$inferSelect) {
  const [[building], [unit], photos, events] = await Promise.all([
    db.select({ name: B.name }).from(B).where(and(eq(B.tenantId, ctx.tenantId), eq(B.id, row.buildingId))).limit(1),
    row.unitId
      ? db.select({ label: U.label }).from(U).where(and(eq(U.tenantId, ctx.tenantId), eq(U.id, row.unitId))).limit(1)
      : Promise.resolve([] as { label: string }[]),
    requestPhotos(db, ctx, row.id, { reporterContactId: contactId }),
    requestEvents(db, ctx, row.id, { reporterContactId: contactId, onlyOwnerVisible: true }), // plan addendum 11
  ]);
  return {
    ...toPortalRow(row, building?.name ?? '', unit?.label ?? null, photos.length),
    description: row.description,
    photos: photos.map((p) => ({ documentId: p.documentId, fileName: p.fileName, mime: p.mime, sizeBytes: p.sizeBytes, createdAt: p.createdAt })),
    events: events.map((e) => ({ id: e.id, kind: e.kind, toStatus: e.toStatus, note: e.note, authorName: e.authorName, authorKind: e.authorKind, createdAt: e.createdAt })),
  };
}

export async function portalMaintenanceList(db: Db, portal: PortalContext, contactIdParam: string) {
  const { ctx, contactId } = resolveLink(portal, contactIdParam);
  const owned = await db.selectDistinct({ buildingId: U.buildingId }).from(U)
    .where(and(eq(U.tenantId, ctx.tenantId), eq(U.ownerContactId, contactId)));
  if (owned.length === 0) return { rows: [], total: 0 };
  const rows = await db.select({ r: MR, buildingName: B.name, unitLabel: U.label, photoCount: PHOTO_COUNT }).from(MR)
    .innerJoin(B, and(eq(B.id, MR.buildingId), eq(B.tenantId, MR.tenantId)))
    .leftJoin(U, and(eq(U.id, MR.unitId), eq(U.tenantId, MR.tenantId)))
    .where(and(eq(MR.tenantId, ctx.tenantId), eq(MR.reportedByContactId, contactId), inArray(MR.buildingId, owned.map((o) => o.buildingId))))
    .orderBy(desc(MR.createdAt), desc(MR.id));
  // An owner's own requests are few: the list is unpaged, so `total` is simply what it holds.
  return { rows: rows.map((r) => toPortalRow(r.r, r.buildingName, r.unitLabel, r.photoCount)), total: rows.length };
}

export async function portalMaintenanceDetail(db: Db, portal: PortalContext, contactIdParam: string, id: string) {
  const { ctx, contactId } = resolveLink(portal, contactIdParam);
  return detail(db, ctx, contactId, await ownedRequest(db, ctx, contactId, id));
}

export async function portalMaintenanceCreate(db: Db, portal: PortalContext, input: {
  contactId: string; buildingId: string; unitId?: string | null | undefined;
  title: string; description: string; category: MaintenanceCategory; priority: MaintenancePriority;
}) {
  const { ctx, contactId } = resolveLink(portal, input.contactId);
  await assertOwnsUnitIn(db, ctx, contactId, input.buildingId); // 404 for anything else
  return db.transaction(async (tx) => {
    if (input.unitId) {
      // Their own unit, in that building: an owner reports on what is theirs.
      const [unit] = await tx.select({ id: U.id }).from(U)
        .where(and(eq(U.tenantId, ctx.tenantId), eq(U.buildingId, input.buildingId), eq(U.id, input.unitId), eq(U.ownerContactId, contactId))).limit(1);
      if (!unit) throw badRequest('invalid_reference', 'unitId is not a unit of yours in this building');
    }
    const [row] = await tx.insert(MR).values({
      tenantId: ctx.tenantId, buildingId: input.buildingId, unitId: input.unitId ?? null,
      title: input.title, description: input.description, category: input.category, priority: input.priority,
      reportedByUserId: null, reportedByContactId: contactId,
    }).returning();
    await recordEvent(tx, ctx, { requestId: row!.id, kind: 'created', toStatus: 'new', note: input.title, visibility: 'owner', authorContactId: contactId });
    // Spec §9's manager side: the in-app bell for a new request from the portal.
    const [building] = await tx.select({ name: B.name }).from(B)
      .where(and(eq(B.tenantId, ctx.tenantId), eq(B.id, input.buildingId))).limit(1);
    await notifyStaff(tx, ctx, {
      kind: 'maintenance_request_created', requestTitle: input.title,
      buildingName: building?.name ?? '', buildingId: input.buildingId,
    });
    await writeAudit(tx, ctx, { action: 'maintenance.portal_create', entityType: 'maintenance_request', entityId: row!.id, after: row });
    return detail(tx, ctx, contactId, row!);
  });
}

/** Everything an owner writes is `owner`-visible: they cannot hide a note from themselves (addendum 11). */
export async function portalMaintenanceComment(db: Db, portal: PortalContext, contactIdParam: string, id: string, note: string) {
  const { ctx, contactId } = resolveLink(portal, contactIdParam);
  const row = await ownedRequest(db, ctx, contactId, id);
  // The board's answer, from the portal side too: a closed request takes no more comments.
  if (isTerminal(row.status)) throw conflict('status_locked', 'A closed request takes no more comments');
  return db.transaction(async (tx) => {
    await recordEvent(tx, ctx, { requestId: row.id, kind: 'comment', note, visibility: 'owner', authorContactId: contactId });
    await writeAudit(tx, ctx, { action: 'maintenance.portal_event', entityType: 'maintenance_request', entityId: row.id, after: { note, contactId } });
    return detail(tx, ctx, contactId, row);
  });
}

export async function portalMaintenancePhoto(db: Db, portal: PortalContext, store: DocumentStore, contactIdParam: string, id: string, input: Omit<NewPhoto, 'contactId'>) {
  const { ctx, contactId } = resolveLink(portal, contactIdParam);
  const row = await ownedRequest(db, ctx, contactId, id);
  await addPhoto(db, ctx, store, row.id, { ...input, contactId });
  return detail(db, ctx, contactId, row);
}

export async function portalMaintenancePhotoFile(db: Db, portal: PortalContext, contactIdParam: string, id: string, documentId: string) {
  const { ctx, contactId } = resolveLink(portal, contactIdParam);
  const row = await ownedRequest(db, ctx, contactId, id);
  return photoFile(db, ctx, row.id, documentId);
}
