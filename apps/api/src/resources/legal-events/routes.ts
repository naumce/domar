import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { listLegalEvents } from '../../legal-events.js';
import { getBuilding } from '../buildings/repo.js';
import { buildingParam } from '../units/schema.js';
import { legalEventListOut, legalEventQuery } from './schema.js';

/**
 * Read-only by design (spec §11): the table is append-only, so this plugin registers a GET and
 * nothing else. Every role may read it, `readonly` included.
 */
export const legalEventRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  app.get('/', { schema: { params: buildingParam, querystring: legalEventQuery, response: { 200: legalEventListOut } } }, async (req) => {
    await getBuilding(req.db, req.ctx!, req.params.buildingId); // 404 across tenants
    return listLegalEvents(req.db, req.ctx!, req.params.buildingId, req.query);
  });
};
