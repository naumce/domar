import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/health', {
    schema: {
      response: {
        200: z.object({ status: z.enum(['ok', 'degraded']), db: z.enum(['ok', 'down']) }),
        503: z.object({ status: z.enum(['ok', 'degraded']), db: z.enum(['ok', 'down']) }),
      },
    },
  }, async (_req, reply) => {
    let db: 'ok' | 'down' = 'ok';
    try {
      await app.sql`select 1`;
    } catch {
      db = 'down';
    }
    if (db === 'down') return reply.status(503).send({ status: 'degraded', db });
    return { status: 'ok' as const, db };
  });
};
