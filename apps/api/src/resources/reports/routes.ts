import type { FastifyInstance } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireRole, WRITE_ROLES } from '../../auth/roles.js';
import { renderAnnualReportHtml } from '../../pdf/annual-report-html.js';
import { buildingParam } from '../units/schema.js';
import { annualReport } from './data.js';
import { annualDataOut, annualIssueBody, annualQuery, reportIssueOut, reportListOut } from './schema.js';
import { issueAnnualReport, listReports, type ReportRuntime } from './service.js';

export const reportRuntime = (app: FastifyInstance): ReportRuntime => ({
  pdfBrowserChannel: app.config.pdfBrowserChannel, documents: app.documents, log: app.log,
});

/** Reads for every role, `readonly` included (spec §10); issuing is a write. */
export const reportRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  // Issuing renders a PDF in Chrome, so it is rate-limited far tighter than an ordinary write.
  const issue = { preHandler: requireRole(...WRITE_ROLES), config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.get('/', { schema: { params: buildingParam, response: { 200: reportListOut } } }, async (req) =>
    listReports(req.db, req.ctx!, req.params.buildingId));

  app.get('/annual/preview', { schema: { params: buildingParam, querystring: annualQuery, response: { 200: annualDataOut } } }, async (req) =>
    (await annualReport(req.db, req.ctx!, req.params.buildingId, req.query.year)).data);

  app.get('/annual/html', { schema: { params: buildingParam, querystring: annualQuery } }, async (req, reply) => {
    const { building, tenant, pack, data } = await annualReport(req.db, req.ctx!, req.params.buildingId, req.query.year);
    const html = renderAnnualReportHtml({
      tenant, building, data, labels: pack.labels.reports,
      formatMoney: (minor) => pack.formatMoney(minor), timeZone: tenant.timezone, locale: 'mk', createdAt: new Date(),
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });

  app.post('/annual', { ...issue, schema: { params: buildingParam, body: annualIssueBody, response: { 201: reportIssueOut } } }, async (req, reply) =>
    reply.status(201).send(await issueAnnualReport(req.db, req.ctx!, req.params.buildingId, req.body.year, reportRuntime(app))));
};
