import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireRole, WRITE_ROLES } from '../../auth/roles.js';
import { buildingParam } from '../units/schema.js';
import { addLine, createPeriod, deleteLine, getPeriod, listPeriods, refreshAutoLines, updateLine, updatePeriod } from './repo.js';
import { lineCreate, lineOut, lineParam, linePatch, periodCreate, periodDetailOut, periodOut, periodParam, periodPatch } from './schema.js';

export const periodRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  const write = { preHandler: requireRole(...WRITE_ROLES) };
  app.get('/', { schema: { params: buildingParam, response: { 200: z.object({ rows: z.array(periodOut) }) } } }, async (req) => listPeriods(req.db, req.ctx!, req.params.buildingId));
  app.post('/', { ...write, schema: { params: buildingParam, body: periodCreate, response: { 201: periodDetailOut } } }, async (req, reply) => reply.status(201).send(await createPeriod(req.db, req.ctx!, req.params.buildingId, req.body)));
  app.get('/:id', { schema: { params: periodParam, response: { 200: periodDetailOut } } }, async (req) => getPeriod(req.db, req.ctx!, req.params.buildingId, req.params.id));
  app.patch('/:id', { ...write, schema: { params: periodParam, body: periodPatch, response: { 200: periodDetailOut } } }, async (req) => updatePeriod(req.db, req.ctx!, req.params.buildingId, req.params.id, req.body));
  app.post('/:id/refresh-lines', { ...write, schema: { params: periodParam, response: { 200: periodDetailOut } } }, async (req) => refreshAutoLines(req.db, req.ctx!, req.params.buildingId, req.params.id));
  app.post('/:id/lines', { ...write, schema: { params: periodParam, body: lineCreate, response: { 201: lineOut } } }, async (req, reply) => reply.status(201).send(await addLine(req.db, req.ctx!, req.params.buildingId, req.params.id, req.body)));
  app.patch('/:id/lines/:lineId', { ...write, schema: { params: lineParam, body: linePatch, response: { 200: lineOut } } }, async (req) => updateLine(req.db, req.ctx!, req.params.buildingId, req.params.id, req.params.lineId, req.body));
  app.delete('/:id/lines/:lineId', { ...write, schema: { params: lineParam } }, async (req, reply) => { await deleteLine(req.db, req.ctx!, req.params.buildingId, req.params.id, req.params.lineId); return reply.status(204).send(); });
};
