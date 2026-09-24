import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { AppError } from '../errors.js';
import { htmlToPdf } from '../pdf/html-to-pdf.js';
import { idParam } from '../resources/common.js';
import { portalAssemblies, portalAssembly, portalAssemblyInvitation, portalCastVote } from './assembly-repo.js';
import { portalAssemblyDecisionParam, portalAssemblyListOut, portalAssemblyOut, portalContactQuery, portalVoteBody } from './schema.js';

/**
 * Art. 37 in the portal. Everything here is scoped by the caller's link and by unit ownership, and
 * the one write is additionally fenced by the voting window and a route-level rate limit.
 */
export const portalAssemblyRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requirePortal);

  app.get('/assemblies', { schema: { querystring: portalContactQuery, response: { 200: portalAssemblyListOut } } }, async (req) =>
    portalAssemblies(req.db, req.portal!, req.query.contactId));

  app.get('/assemblies/:id', { schema: { params: idParam, querystring: portalContactQuery, response: { 200: portalAssemblyOut } } }, async (req) =>
    portalAssembly(req.db, req.portal!, req.query.contactId, req.params.id));

  app.post('/assemblies/:id/decisions/:decisionId/vote', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { params: portalAssemblyDecisionParam, body: portalVoteBody, response: { 200: portalAssemblyOut } },
  }, async (req) => portalCastVote(req.db, req.portal!, req.body.contactId, req.params.id, req.params.decisionId, req.body.choice));

  app.get('/assemblies/:id/invitation/pdf', { schema: { params: idParam, querystring: portalContactQuery } }, async (req, reply) => {
    const { html, id } = await portalAssemblyInvitation(req.db, req.portal!, req.query.contactId, req.params.id);
    let pdf: Buffer;
    try {
      pdf = await htmlToPdf(html, app.config.pdfBrowserChannel);
    } catch (err) {
      app.log.warn({ err }, 'pdf browser launch failed');
      throw new AppError(503, 'pdf_unavailable', 'PDF rendering is not available on this server');
    }
    return reply.type('application/pdf').header('content-disposition', `inline; filename="pokana-${id}.pdf"`).send(pdf);
  });
};
