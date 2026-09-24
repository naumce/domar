import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireRole, WRITE_ROLES } from '../../auth/roles.js';
import { AppError, forbidden, unauthorized } from '../../errors.js';
import { htmlToPdf } from '../../pdf/html-to-pdf.js';
import { getBuilding } from '../buildings/repo.js';
import { idParam } from '../common.js';
import { buildingParam } from '../units/schema.js';
import { getReminderRow, listByBuilding } from './repo.js';
import { jobResultOut, reminderListOut, reminderOut } from './schema.js';
import { markPrinted, resendReminder, runAllTenants, runBuildingReminders, type ReminderRuntime } from './service.js';

const runtime = (app: FastifyInstance): ReminderRuntime => ({ mailer: app.mailer, pdfBrowserChannel: app.config.pdfBrowserChannel, log: app.log });

export const buildingReminderRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  app.get('/', { schema: { params: buildingParam, response: { 200: reminderListOut } } }, async (req) => {
    await getBuilding(req.db, req.ctx!, req.params.buildingId); // 404 across tenants
    return listByBuilding(req.db, req.ctx!, req.params.buildingId);
  });
  app.post('/run', { preHandler: requireRole(...WRITE_ROLES), schema: { params: buildingParam, response: { 200: reminderListOut } } }, async (req) =>
    runBuildingReminders(req.db, req.ctx!, req.params.buildingId, runtime(app)));
};

export const reminderRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  app.get('/:id/html', { schema: { params: idParam } }, async (req, reply) => {
    const row = await getReminderRow(req.db, req.ctx!, req.params.id);
    return reply.type('text/html; charset=utf-8').send(row.documentHtml);
  });
  app.get('/:id/pdf', { schema: { params: idParam } }, async (req, reply) => {
    const row = await getReminderRow(req.db, req.ctx!, req.params.id);
    let pdf: Buffer;
    try {
      pdf = await htmlToPdf(row.documentHtml, app.config.pdfBrowserChannel);
    } catch (err) {
      app.log.warn({ err }, 'pdf browser launch failed');
      throw new AppError(503, 'pdf_unavailable', 'PDF rendering is not available on this server');
    }
    return reply.type('application/pdf').header('content-disposition', `inline; filename="opomena-${row.id}.pdf"`).send(pdf);
  });
  app.post('/:id/printed', { preHandler: requireRole(...WRITE_ROLES), schema: { params: idParam, response: { 200: reminderOut } } }, async (req) =>
    markPrinted(req.db, req.ctx!, req.params.id));
  app.post('/:id/resend', { preHandler: requireRole(...WRITE_ROLES), schema: { params: idParam, response: { 200: reminderOut } } }, async (req) =>
    resendReminder(req.db, req.ctx!, req.params.id, runtime(app)));
};

/** No session: the nightly cron authenticates with a shared token (spec §18.3). */
export const jobRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post('/reminders', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } }, schema: { response: { 200: jobResultOut } } }, async (req) => {
    // The header is checked first: an unauthenticated caller learns nothing about this server's
    // configuration, and a misconfigured server still answers a token-less probe with 401.
    const given = req.headers['x-job-token'];
    if (typeof given !== 'string' || given.length === 0) throw unauthorized();
    const expected = app.config.jobToken;
    if (!expected) throw new AppError(503, 'job_token_not_configured', 'JOB_TOKEN is not configured on this server');
    const a = Buffer.from(given, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw forbidden();
    return runAllTenants(req.db, runtime(app));
  });
};
