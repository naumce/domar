import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireRole, WRITE_ROLES } from '../../auth/roles.js';
import { idParam } from '../common.js';
import { buildingParam } from '../units/schema.js';
import { confirmLine, getStatement, ignoreLine, importStatement, listStatements, unmatchLine } from './repo.js';
import { confirmBody, importBody, lineOut, statementDetailOut, statementOut } from './schema.js';

/** /api/buildings/:buildingId/statements */
export const buildingStatementRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  app.get('/', { schema: { params: buildingParam, response: { 200: z.object({ rows: z.array(statementOut) }) } } }, async (req) => listStatements(req.db, req.ctx!, req.params.buildingId));
  // Statement files run to a couple of MB; the 2 MB `too_large` guard in the repo is the real limit,
  // so the body limit sits above it and fastify's own 1 MB default does not pre-empt it.
  app.post('/', { preHandler: requireRole(...WRITE_ROLES), bodyLimit: 3 * 1024 * 1024, schema: { params: buildingParam, body: importBody, response: { 201: statementDetailOut } } },
    async (req, reply) => reply.status(201).send(await importStatement(req.db, req.ctx!, req.params.buildingId, req.body)));
};

/** /api/statements */
export const statementRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  app.get('/:id', { schema: { params: idParam, response: { 200: statementDetailOut } } }, async (req) => getStatement(req.db, req.ctx!, req.params.id));
};

/** /api/statement-lines */
export const statementLineRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  const write = { preHandler: requireRole(...WRITE_ROLES) };
  app.post('/:id/confirm', { ...write, schema: { params: idParam, body: confirmBody, response: { 200: lineOut } } }, async (req) => confirmLine(req.db, req.ctx!, req.params.id, req.body.invoiceId));
  app.post('/:id/ignore', { ...write, schema: { params: idParam, response: { 200: lineOut } } }, async (req) => ignoreLine(req.db, req.ctx!, req.params.id));
  app.post('/:id/unmatch', { ...write, schema: { params: idParam, response: { 200: lineOut } } }, async (req) => unmatchLine(req.db, req.ctx!, req.params.id));
};
