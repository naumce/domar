import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireRole, WRITE_ROLES } from '../../auth/roles.js';
import { buildingParam } from '../units/schema.js';
import { importUnits } from './repo.js';
import { importResultOut, importUnitsBody } from './schema.js';

/**
 * /api/buildings/:buildingId/import — CSV import. `dryRun` and `mode` are body fields, not query
 * parameters, so one schema covers the preview and the commit. Both answer 200.
 */
export const importRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  app.post('/units', {
    preHandler: requireRole(...WRITE_ROLES),
    bodyLimit: 3 * 1024 * 1024,
    schema: { params: buildingParam, body: importUnitsBody, response: { 200: importResultOut } },
  }, async (req) => importUnits(req.db, req.ctx!, req.params.buildingId, req.body));
};
