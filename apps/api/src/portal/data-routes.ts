import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { htmlToPdf } from '../pdf/html-to-pdf.js';
import { idParam } from '../resources/common.js';
import { invoiceDetailOut, invoiceRowOut } from '../resources/invoices/schema.js';
import { paymentOut } from '../resources/payments/schema.js';
import { statementOut } from '../resources/contacts/schema.js';
import { portalBuildingFund, portalInvoice, portalInvoiceHtml, portalInvoices, portalPayments, portalStatement } from './repo.js';
import { portalContactQuery, portalFundOut, portalInvoiceListQuery, portalPaymentListQuery, portalStatementQuery } from './schema.js';

/** Read-only, scoped by link. Nothing here writes, and nothing here sees a request-supplied tenant. */
export const portalDataRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requirePortal);

  app.get('/invoices', { schema: { querystring: portalInvoiceListQuery, response: { 200: z.object({ rows: z.array(invoiceRowOut), total: z.number() }) } } }, async (req) =>
    portalInvoices(req.db, req.portal!, req.query));

  app.get('/invoices/:id', { schema: { params: idParam, querystring: portalContactQuery, response: { 200: invoiceDetailOut } } }, async (req) =>
    portalInvoice(req.db, req.portal!, req.query.contactId, req.params.id));

  app.get('/invoices/:id/pdf', { schema: { params: idParam, querystring: portalContactQuery } }, async (req, reply) => {
    const { html, invoice } = await portalInvoiceHtml(req.db, req.portal!, req.query.contactId, req.params.id);
    let pdf: Buffer;
    try {
      pdf = await htmlToPdf(html, app.config.pdfBrowserChannel);
    } catch (err) {
      app.log.warn({ err }, 'pdf browser launch failed');
      throw new AppError(503, 'pdf_unavailable', 'PDF rendering is not available on this server');
    }
    const name = (invoice.number ?? `invoice-${invoice.id}`).replace(/[^A-Za-z0-9_.-]/g, '_');
    return reply.type('application/pdf').header('content-disposition', `inline; filename="${name}.pdf"`).send(pdf);
  });

  app.get('/payments', { schema: { querystring: portalPaymentListQuery, response: { 200: z.object({ rows: z.array(paymentOut), total: z.number() }) } } }, async (req) =>
    portalPayments(req.db, req.portal!, req.query));

  app.get('/statement', { schema: { querystring: portalStatementQuery, response: { 200: statementOut } } }, async (req) =>
    portalStatement(req.db, req.portal!, req.query.contactId, req.query.buildingId));

  app.get('/buildings/:id/fund', { schema: { params: idParam, querystring: portalContactQuery, response: { 200: portalFundOut } } }, async (req) =>
    portalBuildingFund(req.db, req.portal!, req.query.contactId, req.params.id));
};
