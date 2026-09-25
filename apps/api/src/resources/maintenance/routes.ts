import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { MAINTENANCE_ROLES, requireRole, WRITE_ROLES } from '../../auth/roles.js';
import { idParam } from '../common.js';
import { buildingParam } from '../units/schema.js';
import { addEvent, assignRequest, createRequest, getRequest, listRequests, setStatus, updateRequest } from './repo.js';
import { maintenanceAssignBody, maintenanceCreate, maintenanceEventBody, maintenanceListOut, maintenanceListQuery, maintenanceOut, maintenancePatch, maintenanceStatusBody } from './schema.js';

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
};
