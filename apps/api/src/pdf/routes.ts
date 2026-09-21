import { getCountryPack, type CountryCode } from '@domar/domain';
import { schema, type Db } from '@domar/db';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { AppError } from '../errors.js';
import { idParam } from '../resources/common.js';
import { getInvoice } from '../resources/invoices/repo.js';
import type { TenantContext } from '../tenant-context.js';
import { htmlToPdf } from './html-to-pdf.js';
import { renderInvoiceHtml } from './invoice-html.js';

export const pdfRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  const render = async (db: Db, ctx: TenantContext, id: string) => {
    const invoice = await getInvoice(db, ctx, id);
    const tenant = (await db.query.tenants.findFirst({ where: eq(schema.tenants.id, ctx.tenantId) }))!;
    const pack = getCountryPack(tenant.countryCode as CountryCode);
    return { html: renderInvoiceHtml({ invoice, tenant, formatMoney: pack.formatMoney, locale: 'mk' }), invoice };
  };
  app.get('/:id/html', { schema: { params: idParam } }, async (req, reply) => {
    const { html } = await render(req.db, req.ctx!, req.params.id);
    return reply.type('text/html; charset=utf-8').send(html);
  });
  app.get('/:id/pdf', { schema: { params: idParam } }, async (req, reply) => {
    const { html, invoice } = await render(req.db, req.ctx!, req.params.id);
    let pdf: Buffer;
    try {
      pdf = await htmlToPdf(html, app.config.pdfBrowserChannel);
    } catch (err) {
      app.log.warn({ err }, 'pdf browser launch failed');
      throw new AppError(503, 'pdf_unavailable', 'PDF rendering is not available on this server');
    }
    const name = (invoice.number ?? `draft-${invoice.id}`).replace(/[^A-Za-z0-9_.-]/g, '_');
    return reply.type('application/pdf').header('content-disposition', `inline; filename="${name}.pdf"`).send(pdf);
  });
};
