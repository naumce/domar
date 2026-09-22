import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { Db } from '@domar/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors, jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type postgres from 'postgres';
import type { Config } from './config.js';
import { authPlugin } from './auth/plugin.js';
import { authRoutes } from './auth/routes.js';
import { AppError } from './errors.js';
import { pdfRoutes } from './pdf/routes.js';
import { dbPlugin } from './plugins/db.js';
import { buildingServiceRoutes } from './resources/building-services/routes.js';
import { buildingRoutes } from './resources/buildings/routes.js';
import { contactRoutes } from './resources/contacts/routes.js';
import { invoiceRoutes } from './resources/invoices/routes.js';
import { invoicingRoutes } from './resources/invoicing/routes.js';
import { periodRoutes } from './resources/periods/routes.js';
import { reserveFundRoutes } from './resources/reserve-fund/routes.js';
import { serviceRoutes } from './resources/services/routes.js';
import { taxRateRoutes } from './resources/tax-rates/routes.js';
import { unitRoutes } from './resources/units/routes.js';
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

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({ error: { code: 'not_found', message: `Route ${req.method} ${req.url} not found` } });
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
    await api.register(taxRateRoutes, { prefix: '/tax-rates' });
    await api.register(contactRoutes, { prefix: '/contacts' });
    await api.register(serviceRoutes, { prefix: '/services' });
    await api.register(buildingRoutes, { prefix: '/buildings' });
    await api.register(unitRoutes, { prefix: '/buildings/:buildingId/units' });
    await api.register(buildingServiceRoutes, { prefix: '/buildings/:buildingId/services' });
    await api.register(reserveFundRoutes, { prefix: '/buildings/:buildingId/reserve-fund' });
    await api.register(periodRoutes, { prefix: '/buildings/:buildingId/periods' });
    await api.register(invoicingRoutes, { prefix: '/buildings/:buildingId/periods' });
    await api.register(invoiceRoutes, { prefix: '/invoices' });
    await api.register(pdfRoutes, { prefix: '/invoices' });
  }, { prefix: '/api' });

  return app;
}

declare module 'fastify' {
  interface FastifyInstance { config: Config }
}
