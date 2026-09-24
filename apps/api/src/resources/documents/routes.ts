import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireRole, WRITE_ROLES } from '../../auth/roles.js';
import { contentDisposition } from '../../documents/store.js';
import { badRequest } from '../../errors.js';
import { getBuilding } from '../buildings/repo.js';
import { idParam } from '../common.js';
import { buildingParam } from '../units/schema.js';
import { createDocument, deleteDocument, getDocumentRow, listDocuments, publicDocument } from './repo.js';
import { documentKindEnum, documentListOut, documentListQuery, documentOut, type DocumentKind } from './schema.js';

/** Multipart fields arrive before the file part; anything after it is invisible to busboy. */
function fieldValue(fields: Record<string, unknown> | undefined, name: string): string | undefined {
  const f = fields?.[name] as { value?: unknown } | undefined;
  return typeof f?.value === 'string' ? f.value : undefined;
}

export const buildingDocumentRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get('/', { schema: { params: buildingParam, querystring: documentListQuery, response: { 200: documentListOut } } }, async (req) =>
    listDocuments(req.db, req.ctx!, req.params.buildingId, req.query.kind));

  // No zod `body`: the payload is multipart, validated field by field below.
  app.post('/', {
    preHandler: requireRole(...WRITE_ROLES),
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: { params: buildingParam, response: { 201: documentOut } },
  }, async (req, reply) => {
    await getBuilding(req.db, req.ctx!, req.params.buildingId); // 404 across tenants, before a byte is read
    const part = await req.file();
    if (!part) throw badRequest('file_required', 'A file part is required');
    // busboy calls an `application/octet-stream` part a file even without a filename, so this is
    // reachable and has to be rejected before a byte is written.
    const filename = part.filename ?? '';
    if (!filename) throw badRequest('file_required', 'The file part must carry a filename');
    const kind = documentKindEnum.safeParse(fieldValue(part.fields as Record<string, unknown>, 'kind'));
    if (!kind.success) throw badRequest('validation', 'kind must be one of contract, minutes, report, invoice_supplier, photo, other');
    const title = (fieldValue(part.fields as Record<string, unknown>, 'title') ?? filename).slice(0, 200).trim();
    if (!title) throw badRequest('validation', 'title is required');
    const created = await createDocument(req.db, req.ctx!, app.documents, {
      buildingId: req.params.buildingId,
      kind: kind.data as DocumentKind,
      title,
      fileName: filename.slice(0, 255),
      mime: part.mimetype,
      stream: part.file,
      isTruncated: () => part.file.truncated,
    });
    return reply.status(201).send(created);
  });
};

export const documentRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get('/:id', { schema: { params: idParam, response: { 200: documentOut } } }, async (req) =>
    publicDocument(await getDocumentRow(req.db, req.ctx!, req.params.id)));

  app.get('/:id/download', { schema: { params: idParam } }, async (req, reply) => {
    const row = await getDocumentRow(req.db, req.ctx!, req.params.id);
    const stream = await app.documents.open(row.storageKey);
    return reply
      .type(row.mime)
      .header('content-length', String(row.sizeBytes))
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', contentDisposition(row.fileName))
      .send(stream);
  });

  app.delete('/:id', { preHandler: requireRole(...WRITE_ROLES), schema: { params: idParam } }, async (req, reply) => {
    await deleteDocument(req.db, req.ctx!, app.documents, req.params.id, app.log);
    return reply.status(204).send();
  });
};
