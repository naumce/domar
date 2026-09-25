import type { Readable } from 'node:stream';
import { type Db, schema } from '@domar/db';
import { isTerminal } from '@domar/domain';
import { and, count, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { writeAudit } from '../../audit.js';
import type { DocumentStore } from '../../documents/store.js';
import { conflict, notFound } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { createDocument, deleteDocument } from '../documents/repo.js';
import { getRequestRow, MR, recordEvent } from './repo.js';

const MP = schema.maintenancePhotos;
const D = schema.documents;

/** Spec §4 stores photos as documents; §11 wants them mime-checked and size-capped. Narrower than `ALLOWED_MIME`. */
export const PHOTO_MIME: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg' };
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
export const MAX_PHOTOS_PER_REQUEST = 12;

export interface NewPhoto {
  title: string;
  fileName: string;
  mime: string;
  stream: Readable;
  isTruncated: () => boolean;
  /** Set when the upload arrived through the portal; the staff route leaves it out. */
  contactId?: string | undefined;
}

/**
 * The bytes go through the same `createDocument` every other document does — same store, same
 * sha256, same audit row — with a narrower allowlist. The join row follows in its own transaction,
 * and if that fails the document is unwound, because a `photo` document nothing points at is a file
 * no screen can ever show or delete.
 *
 * The caller has already proved it may touch this request: the staff route through `getRequestRow`
 * below, the portal route through `resolveLink` + `assertOwnsUnitIn` + the reporter check.
 */
export async function addPhoto(db: Db, ctx: TenantContext, store: DocumentStore, requestId: string, input: NewPhoto) {
  const request = await getRequestRow(db, ctx, requestId);
  if (isTerminal(request.status)) throw conflict('status_locked', 'A closed request takes no more photos');
  const created = await createDocument(db, ctx, store, {
    buildingId: request.buildingId,
    kind: 'photo',
    title: input.title,
    fileName: input.fileName,
    mime: input.mime,
    stream: input.stream,
    isTruncated: input.isTruncated,
    allow: PHOTO_MIME,
  });
  try {
    await db.transaction(async (tx) => {
      // The cap is counted here, not before `createDocument`: a count taken outside this write lets
      // two uploads racing at eleven both pass and land thirteen. The row lock on the request is what
      // orders them — the count alone would still be read twice under READ COMMITTED. A refused
      // upload unwinds its document and its bytes through the catch below.
      await tx.select({ id: MR.id }).from(MR)
        .where(and(eq(MR.tenantId, ctx.tenantId), eq(MR.id, requestId))).for('update');
      const [existing] = await tx.select({ n: count() }).from(MP)
        .where(and(eq(MP.tenantId, ctx.tenantId), eq(MP.maintenanceRequestId, requestId)));
      if (Number(existing?.n ?? 0) >= MAX_PHOTOS_PER_REQUEST) {
        throw conflict('too_many_photos', `A request holds at most ${MAX_PHOTOS_PER_REQUEST} photos`);
      }
      await tx.insert(MP).values({
        tenantId: ctx.tenantId,
        maintenanceRequestId: requestId,
        documentId: created.id,
        uploadedByUserId: input.contactId ? null : ctx.userId,
        uploadedByContactId: input.contactId ?? null,
      });
      await recordEvent(tx, ctx, {
        requestId, kind: 'photo_added', note: created.fileName, visibility: 'owner',
        ...(input.contactId ? { authorContactId: input.contactId } : {}),
      });
      await writeAudit(tx, ctx, {
        action: 'maintenance.photo.create', entityType: 'maintenance_request', entityId: requestId,
        after: { documentId: created.id, fileName: created.fileName, sizeBytes: created.sizeBytes },
      });
    });
  } catch (err) {
    await db.delete(D).where(and(eq(D.tenantId, ctx.tenantId), eq(D.id, created.id)));
    await store.remove(created.storageKey);
    throw err;
  }
}

/** The photo row, its document and its bytes. `WRITE_ROLES` only: a technician adds evidence, never removes it. */
export async function deletePhoto(db: Db, ctx: TenantContext, store: DocumentStore, requestId: string, documentId: string, log?: FastifyBaseLogger): Promise<void> {
  await getRequestRow(db, ctx, requestId);
  await db.transaction(async (tx) => {
    const [row] = await tx.select({ fileName: D.fileName }).from(MP)
      .innerJoin(D, and(eq(D.id, MP.documentId), eq(D.tenantId, MP.tenantId)))
      .where(and(eq(MP.tenantId, ctx.tenantId), eq(MP.maintenanceRequestId, requestId), eq(MP.documentId, documentId))).limit(1);
    if (!row) throw notFound('Photo');
    // The gallery is a second door onto `documents`, not a way around it: a photo an expense, a
    // contract or an assembly points at is that record's evidence, and `deleteDocument` is the one
    // place that knows so (spec §4, addendum 13). It answers 409 `document_referenced`, takes the
    // bytes away and writes its own audit row; the join row needs no delete of its own, because
    // `maintenance_photos.document_id` is `on delete cascade`. The maintenance audit row is written
    // first, so nothing of this transaction can fail after the file has left the store.
    await writeAudit(tx, ctx, {
      action: 'maintenance.photo.delete', entityType: 'maintenance_request', entityId: requestId,
      before: { documentId, fileName: row.fileName },
    });
    await deleteDocument(tx, ctx, store, documentId, log);
  });
}

/** The document row behind one photo of one request, for streaming it back. */
export async function photoFile(db: Db, ctx: TenantContext, requestId: string, documentId: string) {
  const [row] = await db.select({ storageKey: D.storageKey, mime: D.mime, fileName: D.fileName, sizeBytes: D.sizeBytes })
    .from(MP).innerJoin(D, and(eq(D.id, MP.documentId), eq(D.tenantId, MP.tenantId)))
    .where(and(eq(MP.tenantId, ctx.tenantId), eq(MP.maintenanceRequestId, requestId), eq(MP.documentId, documentId))).limit(1);
  if (!row) throw notFound('Photo');
  return row;
}
