import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { MAINTENANCE_ROLES, requireRole, WRITE_ROLES } from '../../auth/roles.js';
import { contentDisposition } from '../../documents/store.js';
import { badRequest } from '../../errors.js';
import { idParam } from '../common.js';
import { buildingParam } from '../units/schema.js';
import { addPhoto, deletePhoto, MAX_PHOTO_BYTES, photoFile } from './photos.js';
import { addEvent, assignRequest, createRequest, getRequest, getRequestRow, listRequests, setStatus, updateRequest } from './repo.js';
import { maintenanceAssignBody, maintenanceCreate, maintenanceEventBody, maintenanceListOut, maintenanceListQuery, maintenanceOut, maintenancePatch, maintenancePhotoParam, maintenanceStatusBody } from './schema.js';

/** Spec §8 board of one building. Reads are open to every role; a technician's list is their own. */
export const buildingMaintenanceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get('/', { schema: { params: buildingParam, querystring: maintenanceListQuery, response: { 200: maintenanceListOut } } }, async (req) =>
    listRequests(req.db, req.ctx!, req.params.buildingId, req.query));

  app.post('/', { preHandler: requireRole(...WRITE_ROLES), schema: { params: buildingParam, body: maintenanceCreate, response: { 201: maintenanceOut } } }, async (req, reply) =>
    reply.status(201).send(await createRequest(req.db, req.ctx!, req.params.buildingId, req.body)));
};

export const maintenanceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  const write = { preHandler: requireRole(...WRITE_ROLES) };
  // Spec §10: the technician's three verbs. The repo scopes each of them to their own requests.
  const worker = { preHandler: requireRole(...MAINTENANCE_ROLES) };

  app.get('/:id', { schema: { params: idParam, response: { 200: maintenanceOut } } }, async (req) =>
    getRequest(req.db, req.ctx!, req.params.id));

  app.patch('/:id', { ...write, schema: { params: idParam, body: maintenancePatch, response: { 200: maintenanceOut } } }, async (req) =>
    updateRequest(req.db, req.ctx!, req.params.id, req.body));

  app.post('/:id/status', { ...worker, schema: { params: idParam, body: maintenanceStatusBody, response: { 200: maintenanceOut } } }, async (req) =>
    setStatus(req.db, req.ctx!, req.params.id, req.body));

  app.post('/:id/assign', { ...write, schema: { params: idParam, body: maintenanceAssignBody, response: { 200: maintenanceOut } } }, async (req) =>
    assignRequest(req.db, req.ctx!, req.params.id, req.body));

  app.post('/:id/events', { ...worker, schema: { params: idParam, body: maintenanceEventBody, response: { 201: maintenanceOut } } }, async (req, reply) =>
    reply.status(201).send(await addEvent(req.db, req.ctx!, req.params.id, req.body)));

  // Multipart, so no zod `body`: the one field is read off the part before the file (see below).
  app.post('/:id/photos', {
    ...worker,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: { params: idParam, response: { 201: maintenanceOut } },
  }, async (req, reply) => {
    // Eight megabytes for a photo, not the twenty a contract may weigh: the per-request limit wins
    // over the global one, so busboy truncates at eight and `createDocument` answers 413.
    const part = await req.file({ limits: { fileSize: MAX_PHOTO_BYTES } });
    if (!part) throw badRequest('file_required', 'A file part is required');
    try {
      const filename = part.filename ?? '';
      if (!filename) throw badRequest('file_required', 'The file part must carry a filename');
      const fields = part.fields as Record<string, { value?: unknown } | undefined> | undefined;
      const rawTitle = fields?.['title'];
      const title = (typeof rawTitle?.value === 'string' ? rawTitle.value : filename).slice(0, 200).trim() || filename;
      await addPhoto(req.db, req.ctx!, app.documents, req.params.id, {
        title, fileName: filename.slice(0, 255), mime: part.mimetype, stream: part.file, isTruncated: () => part.file.truncated,
      });
    } catch (err) {
      // A refused upload — wrong request, wrong mime, closed request — leaves the part unread, and
      // an unread part leaves the rest of the body sitting in the socket. Draining it is a no-op
      // once `createDocument` has consumed the stream.
      part.file.resume();
      throw err;
    }
    return reply.status(201).send(await getRequest(req.db, req.ctx!, req.params.id));
  });

  /**
   * The gallery's own download. `/api/documents/:id/download` is staff-wide and is now closed to a
   * technician, so a photo reaches them through the request it hangs on: `getRequestRow` applies the
   * same technician scope the card itself does, and a request that is not theirs is a 404 — with it,
   * every photo on it. Open to every role, exactly like the card (spec §10).
   */
  app.get('/:id/photos/:documentId', { schema: { params: maintenancePhotoParam } }, async (req, reply) => {
    await getRequestRow(req.db, req.ctx!, req.params.id);
    const row = await photoFile(req.db, req.ctx!, req.params.id, req.params.documentId);
    const stream = await app.documents.open(row.storageKey);
    return reply
      .type(row.mime)
      .header('content-length', String(row.sizeBytes))
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', contentDisposition(row.fileName, 'inline'))
      .send(stream);
  });

  app.delete('/:id/photos/:documentId', { ...write, schema: { params: maintenancePhotoParam } }, async (req, reply) => {
    await deletePhoto(req.db, req.ctx!, app.documents, req.params.id, req.params.documentId, app.log);
    return reply.status(204).send();
  });
};
