import type { FastifyInstance } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireRole, WRITE_ROLES } from '../../auth/roles.js';
import { AppError } from '../../errors.js';
import { htmlToPdf } from '../../pdf/html-to-pdf.js';
import { idParam } from '../common.js';
import { buildingParam } from '../units/schema.js';
import { holdAssembly } from './hold.js';
import { createAssembly, createDecision, deleteAssembly, deleteDecision, getAssembly, listAssemblies, updateAssembly, updateDecision } from './repo.js';
import { assemblyCreate, assemblyDecisionParam, assemblyListOut, assemblyOut, assemblyOwnersOut, assemblyPatch, cancelBody, decisionCreate, decisionPatch, holdBody, inviteBody, paperVoteBody } from './schema.js';
import { assemblyInvitationHtml, assemblyMinutesHtml, cancelAssembly, inviteAssembly, markInvitationPrinted, type AssemblyRuntime } from './service.js';
import { castPaperVote, listAssemblyOwners } from './votes.js';

export const assemblyRuntime = (app: FastifyInstance): AssemblyRuntime => ({
  mailer: app.mailer, pdfBrowserChannel: app.config.pdfBrowserChannel, documents: app.documents, log: app.log,
});

export const buildingAssemblyRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  app.get('/', { schema: { params: buildingParam, response: { 200: assemblyListOut } } }, async (req) =>
    listAssemblies(req.db, req.ctx!, req.params.buildingId));
  app.post('/', { preHandler: requireRole(...WRITE_ROLES), schema: { params: buildingParam, body: assemblyCreate, response: { 201: assemblyOut } } }, async (req, reply) =>
    reply.status(201).send(await createAssembly(req.db, req.ctx!, req.params.buildingId, req.body)));
};

export const assemblyRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  const write = { preHandler: requireRole(...WRITE_ROLES) };

  app.get('/:id', { schema: { params: idParam, response: { 200: assemblyOut } } }, async (req) =>
    getAssembly(req.db, req.ctx!, req.params.id));
  app.patch('/:id', { ...write, schema: { params: idParam, body: assemblyPatch, response: { 200: assemblyOut } } }, async (req) =>
    updateAssembly(req.db, req.ctx!, req.params.id, req.body));
  app.delete('/:id', { ...write, schema: { params: idParam } }, async (req, reply) => {
    await deleteAssembly(req.db, req.ctx!, req.params.id);
    return reply.status(204).send();
  });

  app.post('/:id/decisions', { ...write, schema: { params: idParam, body: decisionCreate, response: { 201: assemblyOut } } }, async (req, reply) =>
    reply.status(201).send(await createDecision(req.db, req.ctx!, req.params.id, req.body)));
  app.patch('/:id/decisions/:decisionId', { ...write, schema: { params: assemblyDecisionParam, body: decisionPatch, response: { 200: assemblyOut } } }, async (req) =>
    updateDecision(req.db, req.ctx!, req.params.id, req.params.decisionId, req.body));
  app.delete('/:id/decisions/:decisionId', { ...write, schema: { params: assemblyDecisionParam } }, async (req, reply) => {
    await deleteDecision(req.db, req.ctx!, req.params.id, req.params.decisionId);
    return reply.status(204).send();
  });

  app.get('/:id/owners', { schema: { params: idParam, response: { 200: assemblyOwnersOut } } }, async (req) =>
    listAssemblyOwners(req.db, req.ctx!, req.params.id));
  app.post('/:id/decisions/:decisionId/votes', { ...write, schema: { params: assemblyDecisionParam, body: paperVoteBody, response: { 200: assemblyOut } } }, async (req) =>
    castPaperVote(req.db, req.ctx!, req.params.id, req.params.decisionId, req.body));
  app.post('/:id/hold', { ...write, schema: { params: idParam, body: holdBody, response: { 200: assemblyOut } } }, async (req) =>
    holdAssembly(req.db, req.ctx!, req.params.id, req.body, assemblyRuntime(app)));

  app.post('/:id/invite', { ...write, schema: { params: idParam, body: inviteBody, response: { 200: assemblyOut } } }, async (req) =>
    inviteAssembly(req.db, req.ctx!, req.params.id, { ...(req.body?.override ? { override: req.body.override } : {}) }, assemblyRuntime(app)));
  app.post('/:id/cancel', { ...write, schema: { params: idParam, body: cancelBody, response: { 200: assemblyOut } } }, async (req) =>
    cancelAssembly(req.db, req.ctx!, req.params.id, req.body.reason));

  // Readable by any authenticated role, like the invitation: it is a record, not a write.
  app.get('/:id/minutes/html', { schema: { params: idParam } }, async (req, reply) => {
    const html = await assemblyMinutesHtml(req.db, req.ctx!, req.params.id);
    return reply.type('text/html; charset=utf-8').send(html);
  });
  app.get('/:id/invitation/html', { schema: { params: idParam } }, async (req, reply) => {
    const html = await assemblyInvitationHtml(req.db, req.ctx!, req.params.id);
    return reply.type('text/html; charset=utf-8').send(html);
  });
  app.get('/:id/invitation/pdf', { schema: { params: idParam } }, async (req, reply) => {
    const html = await assemblyInvitationHtml(req.db, req.ctx!, req.params.id);
    let pdf: Buffer;
    try {
      pdf = await htmlToPdf(html, app.config.pdfBrowserChannel);
    } catch (err) {
      app.log.warn({ err }, 'pdf browser launch failed');
      throw new AppError(503, 'pdf_unavailable', 'PDF rendering is not available on this server');
    }
    return reply.type('application/pdf').header('content-disposition', `inline; filename="pokana-${req.params.id}.pdf"`).send(pdf);
  });
};

export const assemblyInvitationRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  app.post('/:id/printed', { preHandler: requireRole(...WRITE_ROLES), schema: { params: idParam, response: { 200: assemblyOut } } }, async (req) =>
    markInvitationPrinted(req.db, req.ctx!, req.params.id));
};
