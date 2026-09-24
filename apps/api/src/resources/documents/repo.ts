import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { type Db, schema } from '@domar/db';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { writeAudit } from '../../audit.js';
import { ALLOWED_MIME, documentStorageKey, MAX_DOCUMENT_BYTES, type DocumentStore } from '../../documents/store.js';
import { AppError, badRequest, conflict, notFound } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { getBuilding } from '../buildings/repo.js';
import type { DocumentKind } from './schema.js';

const D = schema.documents; const BC = schema.buildingContracts; const E = schema.expenses;

export type DocumentRow = typeof D.$inferSelect;
/** Everything but the storage key: what goes on the wire and into the audit trail. */
export const publicDocument = ({ storageKey: _storageKey, tenantId: _tenantId, ...rest }: DocumentRow) => rest;

export async function getDocumentRow(db: Db, ctx: TenantContext, id: string): Promise<DocumentRow> {
  const row = await db.query.documents.findFirst({ where: and(eq(D.tenantId, ctx.tenantId), eq(D.id, id)) });
  if (!row) throw notFound('Document');
  return row;
}

/** Used by Tasks 6 and 7 to validate a `documentId` a client supplied. */
export async function assertDocumentInTenant(db: Db, ctx: TenantContext, id: string | null | undefined): Promise<void> {
  if (!id) return;
  const [row] = await db.select({ id: D.id }).from(D).where(and(eq(D.tenantId, ctx.tenantId), eq(D.id, id))).limit(1);
  if (!row) throw badRequest('invalid_reference', 'documentId does not belong to this organization');
}

export async function listDocuments(db: Db, ctx: TenantContext, buildingId: string, kind?: DocumentKind) {
  await getBuilding(db, ctx, buildingId); // 404 across tenants
  const rows = await db.select().from(D)
    .where(and(eq(D.tenantId, ctx.tenantId), eq(D.buildingId, buildingId), ...(kind ? [eq(D.kind, kind)] : [])))
    .orderBy(desc(D.createdAt), desc(D.id));
  return { rows: rows.map(publicDocument) };
}

export interface NewDocument {
  buildingId: string | null;
  kind: DocumentKind;
  title: string;
  fileName: string;
  mime: string;
  stream: Readable;
  /** Read *after* the stream is consumed: busboy only knows it hit the cap once it has. */
  isTruncated: () => boolean;
}

/**
 * The bytes land first and the row second, so a failed insert cannot leave a document without a
 * file; the reverse — a file without a row — is undone in the catch, so it cannot leave an orphan
 * either.
 */
export async function createDocument(db: Db, ctx: TenantContext, store: DocumentStore, input: NewDocument) {
  if (!ALLOWED_MIME[input.mime]) throw badRequest('unsupported_media_type', `Files of type ${input.mime} are not accepted`);
  const id = randomUUID();
  const now = new Date();
  const storageKey = documentStorageKey(ctx.tenantId, id, input.mime, now);
  const { sizeBytes, sha256 } = await store.put(storageKey, input.stream);
  if (input.isTruncated()) {
    await store.remove(storageKey);
    throw new AppError(413, 'file_too_large', `The file exceeds the ${MAX_DOCUMENT_BYTES} byte limit`);
  }
  if (sizeBytes === 0) {
    await store.remove(storageKey);
    throw badRequest('empty_file', 'The file is empty');
  }
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx.insert(D).values({
        id, tenantId: ctx.tenantId, buildingId: input.buildingId, kind: input.kind, title: input.title,
        fileName: input.fileName, mime: input.mime, sizeBytes, storageKey, sha256, uploadedBy: ctx.userId,
      }).returning();
      await writeAudit(tx, ctx, { action: 'document.create', entityType: 'document', entityId: row!.id, after: publicDocument(row!) });
      return publicDocument(row!);
    });
  } catch (err) {
    await store.remove(storageKey);
    throw err;
  }
}

/** Spec §4/addendum 13: a document a contract or an expense points at is not deletable. */
export async function deleteDocument(db: Db, ctx: TenantContext, store: DocumentStore, id: string, log?: FastifyBaseLogger) {
  const row = await getDocumentRow(db, ctx, id);
  await db.transaction(async (tx) => {
    // Inside the transaction: a contract or an expense that claims the document between the check
    // and the delete cannot end up pointing at a row that is no longer there.
    const [contract] = await tx.select({ id: BC.id }).from(BC).where(and(eq(BC.tenantId, ctx.tenantId), eq(BC.documentId, id))).limit(1);
    const [expense] = await tx.select({ id: E.id }).from(E).where(and(eq(E.tenantId, ctx.tenantId), eq(E.documentId, id))).limit(1);
    if (contract || expense) throw conflict('document_referenced', 'This document is attached to a contract or an expense');
    await tx.delete(D).where(and(eq(D.tenantId, ctx.tenantId), eq(D.id, id)));
    await writeAudit(tx, ctx, { action: 'document.delete', entityType: 'document', entityId: id, before: publicDocument(row) });
  });
  // After the commit: a removed file with a surviving row would be worse than a stray file, and a
  // stray file must not turn a committed delete into a 500 either.
  try {
    await store.remove(row.storageKey);
  } catch (err) {
    log?.warn({ err, documentId: id }, 'document row deleted but its file could not be removed');
  }
}
