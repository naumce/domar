import type { FastifyInstance } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireRole, WRITE_ROLES } from '../auth/roles.js';
import { idParam } from '../resources/common.js';
import { periodParam } from '../resources/periods/schema.js';
import type { ReminderRuntime } from '../resources/reminders/service.js';
import { sendInvoiceEmail, sendPeriodEmails } from './invoice-send.js';

const runtime = (app: FastifyInstance): ReminderRuntime => ({ mailer: app.mailer, pdfBrowserChannel: app.config.pdfBrowserChannel, log: app.log });

const sendOut = z.object({ id: z.string(), status: z.enum(['sent', 'failed']), to: z.string(), error: z.string().nullable() });
const bulkOut = z.object({ sent: z.number().int(), failed: z.number().int(), skipped: z.number().int() });

export const invoiceEmailRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  app.post('/:id/send', { preHandler: requireRole(...WRITE_ROLES), schema: { params: idParam, response: { 200: sendOut } } }, async (req) =>
    sendInvoiceEmail(req.db, req.ctx!, req.params.id, runtime(app)));
};

export const periodEmailRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  app.post('/:id/send', { preHandler: requireRole(...WRITE_ROLES), schema: { params: periodParam, response: { 200: bulkOut } } }, async (req) =>
    sendPeriodEmails(req.db, req.ctx!, req.params.buildingId, req.params.id, runtime(app)));
};
