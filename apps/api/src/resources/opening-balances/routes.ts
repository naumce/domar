import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireRole, WRITE_ROLES } from '../../auth/roles.js';
import { buildingParam } from '../units/schema.js';
import { addOpeningBalances, listOpeningBalances } from './repo.js';
import { openingBalanceCreate, openingBalanceCreated, ownerBalanceList } from './schema.js';

/** /api/buildings/:buildingId/opening-balances — owner (not fund) opening balances. */
export const openingBalanceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  app.get('/', { schema: { params: buildingParam, response: { 200: ownerBalanceList } } }, async (req) =>
    listOpeningBalances(req.db, req.ctx!, req.params.buildingId));
  app.post('/', { preHandler: requireRole(...WRITE_ROLES), schema: { params: buildingParam, body: openingBalanceCreate, response: { 201: openingBalanceCreated } } },
    async (req, reply) => reply.status(201).send(await addOpeningBalances(req.db, req.ctx!, req.params.buildingId, req.body)));
};
