import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireRole, WRITE_ROLES } from '../../auth/roles.js';
import { buildingParam, buildingUnitParam } from '../units/schema.js';
import { addOpeningBalance, createExpense, getReserveFundState, listExpenses, listTransactions, putReserveFundSetting, voidExpense } from './repo.js';
import { expenseCreate, expenseOut, openingBalanceBody, postingOut, settingPut, stateOut, transactionOut, voidBody } from './schema.js';

export const reserveFundRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  const write = { preHandler: requireRole(...WRITE_ROLES) };
  app.get('/', { schema: { params: buildingParam, response: { 200: stateOut } } }, async (req) => getReserveFundState(req.db, req.ctx!, req.params.buildingId));
  app.put('/', { ...write, schema: { params: buildingParam, body: settingPut, response: { 200: stateOut } } }, async (req) => putReserveFundSetting(req.db, req.ctx!, req.params.buildingId, req.body));
  app.post('/opening-balance', { ...write, schema: { params: buildingParam, body: openingBalanceBody, response: { 201: postingOut } } }, async (req, reply) => reply.status(201).send(await addOpeningBalance(req.db, req.ctx!, req.params.buildingId, req.body)));
  app.get('/transactions', { schema: { params: buildingParam, response: { 200: z.object({ rows: z.array(transactionOut) }) } } }, async (req) => listTransactions(req.db, req.ctx!, req.params.buildingId));
  app.get('/expenses', { schema: { params: buildingParam, response: { 200: z.object({ rows: z.array(expenseOut) }) } } }, async (req) => listExpenses(req.db, req.ctx!, req.params.buildingId));
  app.post('/expenses', { ...write, schema: { params: buildingParam, body: expenseCreate, response: { 201: expenseOut } } }, async (req, reply) => reply.status(201).send(await createExpense(req.db, req.ctx!, req.params.buildingId, req.body)));
  app.post('/expenses/:id/void', { ...write, schema: { params: buildingUnitParam, body: voidBody, response: { 200: expenseOut } } }, async (req) => voidExpense(req.db, req.ctx!, req.params.buildingId, req.params.id, req.body.reason));
};
