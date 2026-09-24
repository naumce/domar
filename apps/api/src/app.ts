import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { join, sep } from 'node:path';
import type { Db } from '@domar/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors, jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type postgres from 'postgres';
import type { Config } from './config.js';
import { authPlugin } from './auth/plugin.js';
import { authRoutes } from './auth/routes.js';
import { AppError } from './errors.js';
import { createMailer, type Mailer } from './email/mailer.js';
import { pdfRoutes } from './pdf/routes.js';
import { contactPortalRoutes } from './portal/invite-routes.js';
import { dbPlugin } from './plugins/db.js';
import { buildingServiceRoutes } from './resources/building-services/routes.js';
import { buildingRoutes } from './resources/buildings/routes.js';
import { contactRoutes } from './resources/contacts/routes.js';
import { dashboardRoutes } from './resources/dashboard/routes.js';
import { invoiceEmailRoutes, periodEmailRoutes } from './email/routes.js';
import { invoiceRoutes } from './resources/invoices/routes.js';
import { importRoutes } from './resources/import/routes.js';
import { invoicingRoutes } from './resources/invoicing/routes.js';
import { openingBalanceRoutes } from './resources/opening-balances/routes.js';
import { buildingPaymentRoutes, invoicePaymentRoutes, paymentRoutes } from './resources/payments/routes.js';
import { periodRoutes } from './resources/periods/routes.js';
import { buildingReminderRoutes, jobRoutes, reminderRoutes } from './resources/reminders/routes.js';
import { reserveFundRoutes } from './resources/reserve-fund/routes.js';
import { serviceRoutes } from './resources/services/routes.js';
import { buildingStatementRoutes, statementLineRoutes, statementRoutes } from './resources/statements/routes.js';
import { taxRateRoutes } from './resources/tax-rates/routes.js';
import { tenantRoutes } from './resources/tenant/routes.js';
import { unitRoutes } from './resources/units/routes.js';
import { userRoutes } from './resources/users/routes.js';
import { healthRoutes } from './routes/health.js';

export async function buildApp(opts: { db: Db; sql: postgres.Sql; config: Config }): Promise<FastifyInstance> {
  // Fastify's TS types omit the numeric hop-count form of trustProxy even though it accepts one at
  // runtime (passed through to @fastify/proxy-addr); cast to bridge that gap.
  const trustProxy = opts.config.trustProxy as boolean | string;
  const app = Fastify({ logger: opts.config.env !== 'test', trustProxy, routerOptions: { ignoreTrailingSlash: true } }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cors, { origin: opts.config.corsOrigins, credentials: true });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(swagger, { openapi: { info: { title: 'domar API', version: '0.0.1' } }, transform: jsonSchemaTransform });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });
  await app.register(dbPlugin, { db: opts.db, sql: opts.sql });
  await app.register(authPlugin);
  app.decorate('config', opts.config);
  const mailer = createMailer(opts.config);
  app.decorate('mailer', mailer);
  app.addHook('onClose', async () => { await mailer.close(); });

  // `wildcard: false`: no catch-all GET route, so unknown paths reach the not-found handler below
  // and only that handler decides between the SPA shell and the JSON envelope.
  if (opts.config.serveWeb) {
    // Vite writes content-hashed files into assets/, so those can be cached forever; the shell that
    // names them must always be revalidated, or a deploy keeps serving the previous bundle's HTML.
    const assetsDir = join(opts.config.webDist, 'assets') + sep;
    await app.register(fastifyStatic, {
      root: opts.config.webDist,
      wildcard: false,
      // `send` would otherwise write its own `cache-control` over whatever setHeaders put there.
      cacheControl: false,
      setHeaders: (res, path) => {
        res.setHeader('cache-control', path.startsWith(assetsDir) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }

  app.setNotFoundHandler((req, reply) => {
    // A miss under /assets/ is a stale or wrong bundle reference, never a client route: answering it
    // with the SPA shell would hand the browser HTML where it expects JavaScript.
    if (opts.config.serveWeb && req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/assets/')) return reply.sendFile('index.html');
    return reply.status(404).send({ error: { code: 'not_found', message: `Route ${req.method} ${req.url} not found` } });
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({ error: { code: 'validation', message: 'Invalid request', details: err.validation } });
    }
    if (err instanceof RangeError) {
      return reply.status(400).send({ error: { code: 'out_of_range', message: err.message } });
    }
    if (typeof (err as { statusCode?: number }).statusCode === 'number' && (err as { statusCode: number }).statusCode < 500) {
      const e = err as { statusCode: number; code?: string; message: string };
      return reply.status(e.statusCode).send({ error: { code: e.code?.toLowerCase() ?? 'error', message: e.message } });
    }
    app.log.error(err);
    return reply.status(500).send({ error: { code: 'internal', message: 'Internal error' } });
  });

  await app.register(async (api) => {
    await api.register(healthRoutes);
    await api.register(authRoutes, { prefix: '/auth' });
    await api.register(tenantRoutes, { prefix: '/tenant' });
    await api.register(userRoutes, { prefix: '/users' });
    await api.register(dashboardRoutes, { prefix: '/dashboard' });
    await api.register(taxRateRoutes, { prefix: '/tax-rates' });
    await api.register(contactRoutes, { prefix: '/contacts' });
    await api.register(contactPortalRoutes, { prefix: '/contacts' });
    await api.register(serviceRoutes, { prefix: '/services' });
    await api.register(buildingRoutes, { prefix: '/buildings' });
    await api.register(unitRoutes, { prefix: '/buildings/:buildingId/units' });
    await api.register(buildingServiceRoutes, { prefix: '/buildings/:buildingId/services' });
    await api.register(reserveFundRoutes, { prefix: '/buildings/:buildingId/reserve-fund' });
    await api.register(openingBalanceRoutes, { prefix: '/buildings/:buildingId/opening-balances' });
    await api.register(importRoutes, { prefix: '/buildings/:buildingId/import' });
    await api.register(periodRoutes, { prefix: '/buildings/:buildingId/periods' });
    await api.register(invoicingRoutes, { prefix: '/buildings/:buildingId/periods' });
    await api.register(periodEmailRoutes, { prefix: '/buildings/:buildingId/periods' });
    await api.register(buildingPaymentRoutes, { prefix: '/buildings/:buildingId/payments' });
    await api.register(buildingStatementRoutes, { prefix: '/buildings/:buildingId/statements' });
    await api.register(invoiceRoutes, { prefix: '/invoices' });
    await api.register(invoicePaymentRoutes, { prefix: '/invoices' });
    await api.register(invoiceEmailRoutes, { prefix: '/invoices' });
    await api.register(pdfRoutes, { prefix: '/invoices' });
    await api.register(paymentRoutes, { prefix: '/payments' });
    await api.register(statementRoutes, { prefix: '/statements' });
    await api.register(statementLineRoutes, { prefix: '/statement-lines' });
    await api.register(buildingReminderRoutes, { prefix: '/buildings/:buildingId/reminders' });
    await api.register(reminderRoutes, { prefix: '/reminders' });
    await api.register(jobRoutes, { prefix: '/jobs' });
  }, { prefix: '/api' });

  return app;
}

declare module 'fastify' {
  interface FastifyInstance { config: Config; mailer: Mailer }
}
