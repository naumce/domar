import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireRole, WRITE_ROLES } from '../../auth/roles.js';
import { buildingParam } from '../units/schema.js';
import { extraordinaryCostCreate, extraordinaryCostOut } from './schema.js';
import { distributeExtraordinaryCost } from './service.js';

export const extraordinaryCostRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  app.post('/', {
    preHandler: requireRole(...WRITE_ROLES),
    schema: { params: buildingParam, body: extraordinaryCostCreate, response: { 201: extraordinaryCostOut } },
  }, async (req, reply) => reply.status(201).send(await distributeExtraordinaryCost(req.db, req.ctx!, req.params.buildingId, req.body)));
};
