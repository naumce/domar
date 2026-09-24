import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { buildingParam } from '../units/schema.js';
import { buildingComplianceOut, complianceOverviewOut } from './schema.js';
import { buildingCompliance, tenantCompliance } from './snapshot.js';

/** Read-only for every role, `readonly` included (spec §10). */
export const buildingComplianceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  app.get('/', { schema: { params: buildingParam, response: { 200: buildingComplianceOut } } }, async (req) =>
    buildingCompliance(req.db, req.ctx!, req.params.buildingId));
};

export const complianceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  app.get('/', { schema: { response: { 200: complianceOverviewOut } } }, async (req) => tenantCompliance(req.db, req.ctx!));
};
