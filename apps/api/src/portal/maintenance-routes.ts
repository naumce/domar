import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { contentDisposition } from '../documents/store.js';
import { badRequest } from '../errors.js';
import { idParam } from '../resources/common.js';
import { MAX_PHOTO_BYTES } from '../resources/maintenance/photos.js';
import { portalMaintenanceComment, portalMaintenanceCreate, portalMaintenanceDetail, portalMaintenanceList, portalMaintenancePhoto, portalMaintenancePhotoFile } from './maintenance-repo.js';
import { portalContactQuery, portalMaintenanceCreateBody, portalMaintenanceEventBody, portalMaintenanceListOut, portalMaintenanceOut, portalMaintenancePhotoParam } from './schema.js';

/** Spec §8 in the portal. Every route is scoped by the link, by unit ownership and by the reporter. */
export const portalMaintenanceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requirePortal);

  app.get('/maintenance', { schema: { querystring: portalContactQuery, response: { 200: portalMaintenanceListOut } } }, async (req) =>
    portalMaintenanceList(req.db, req.portal!, req.query.contactId));

  app.post('/maintenance', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { body: portalMaintenanceCreateBody, response: { 201: portalMaintenanceOut } },
  }, async (req, reply) => reply.status(201).send(await portalMaintenanceCreate(req.db, req.portal!, req.body)));

  app.get('/maintenance/:id', { schema: { params: idParam, querystring: portalContactQuery, response: { 200: portalMaintenanceOut } } }, async (req) =>
    portalMaintenanceDetail(req.db, req.portal!, req.query.contactId, req.params.id));

  app.post('/maintenance/:id/events', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { params: idParam, body: portalMaintenanceEventBody, response: { 201: portalMaintenanceOut } },
  }, async (req, reply) => reply.status(201).send(await portalMaintenanceComment(req.db, req.portal!, req.body.contactId, req.params.id, req.body.note)));

  // Multipart: `contactId` travels as a field, which busboy only exposes if it precedes the file.
  app.post('/maintenance/:id/photos', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { params: idParam, response: { 201: portalMaintenanceOut } },
  }, async (req, reply) => {
    const part = await req.file({ limits: { fileSize: MAX_PHOTO_BYTES } });
    if (!part) throw badRequest('file_required', 'A file part is required');
    let out;
    try {
      const filename = part.filename ?? '';
      if (!filename) throw badRequest('file_required', 'The file part must carry a filename');
      const fields = part.fields as Record<string, { value?: unknown } | undefined> | undefined;
      const raw = fields?.['contactId'];
      const contactId = typeof raw?.value === 'string' ? raw.value : '';
      if (!/^[0-9a-f-]{36}$/i.test(contactId)) throw badRequest('validation', 'contactId is required and must precede the file part');
      out = await portalMaintenancePhoto(req.db, req.portal!, app.documents, contactId, req.params.id, {
        title: filename.slice(0, 200), fileName: filename.slice(0, 255), mime: part.mimetype,
        stream: part.file, isTruncated: () => part.file.truncated,
      });
    } catch (err) {
      // Somebody else's request, or a file that is not a photo: the part was never read, so the
      // rest of the body has to be drained before the error goes out.
      part.file.resume();
      throw err;
    }
    return reply.status(201).send(out);
  });

  app.get('/maintenance/:id/photos/:documentId', { schema: { params: portalMaintenancePhotoParam, querystring: portalContactQuery } }, async (req, reply) => {
    const row = await portalMaintenancePhotoFile(req.db, req.portal!, req.query.contactId, req.params.id, req.params.documentId);
    const stream = await app.documents.open(row.storageKey);
    return reply
      .type(row.mime)
      .header('content-length', String(row.sizeBytes))
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', contentDisposition(row.fileName, 'inline'))
      .send(stream);
  });
};
