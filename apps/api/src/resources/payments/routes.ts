import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireRole, WRITE_ROLES } from '../../auth/roles.js';
import { idParam } from '../common.js';
import { buildingParam } from '../units/schema.js';
import { getPayment, listInvoicePayments, listPayments } from './repo.js';
import { onAccountCreate, paymentCreate, paymentListQuery, paymentOut, recordOut, summaryOut, voidBody } from './schema.js';
import { recordPayment, voidPayment } from './service.js';

/** /api/payments */
export const paymentRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  app.get('/', { schema: { querystring: paymentListQuery, response: { 200: z.object({ rows: z.array(paymentOut), total: z.number(), summary: summaryOut }) } } }, async (req) => listPayments(req.db, req.ctx!, req.query));
  app.get('/:id', { schema: { params: idParam, response: { 200: paymentOut } } }, async (req) => getPayment(req.db, req.ctx!, req.params.id));
  app.post('/:id/void', { preHandler: requireRole(...WRITE_ROLES), schema: { params: idParam, body: voidBody, response: { 200: recordOut } } }, async (req) => {
    const r = await req.db.transaction((tx) => voidPayment(tx, req.ctx!, req.params.id, req.body.reason));
    return { payment: await getPayment(req.db, req.ctx!, r.payment.id), invoice: r.invoice };
  });
};

/** /api/invoices/:id/payments */
export const invoicePaymentRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  app.get('/:id/payments', { schema: { params: idParam, response: { 200: z.object({ rows: z.array(paymentOut) }) } } }, async (req) => listInvoicePayments(req.db, req.ctx!, req.params.id));
  app.post('/:id/payments', { preHandler: requireRole(...WRITE_ROLES), schema: { params: idParam, body: paymentCreate, response: { 201: recordOut } } }, async (req, reply) => {
    const r = await req.db.transaction((tx) => recordPayment(tx, req.ctx!, { ...req.body, invoiceId: req.params.id, paidAt: new Date(req.body.paidAt) }));
    return reply.status(201).send({ payment: await getPayment(req.db, req.ctx!, r.payment.id), invoice: r.invoice });
  });
};

/** /api/buildings/:buildingId/payments (on account) */
export const buildingPaymentRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  app.post('/', { preHandler: requireRole(...WRITE_ROLES), schema: { params: buildingParam, body: onAccountCreate, response: { 201: recordOut } } }, async (req, reply) => {
    const r = await req.db.transaction((tx) => recordPayment(tx, req.ctx!, { ...req.body, invoiceId: null, buildingId: req.params.buildingId, paidAt: new Date(req.body.paidAt) }));
    return reply.status(201).send({ payment: await getPayment(req.db, req.ctx!, r.payment.id), invoice: r.invoice });
  });
};
