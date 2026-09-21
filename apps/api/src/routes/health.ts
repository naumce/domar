import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/health', { schema: { response: { 200: z.object({ status: z.literal('ok'), db: z.enum(['ok', 'down']) }) } } }, async () => {
    let db: 'ok' | 'down' = 'ok';
    try {
      await app.sql`select 1`;
    } catch {
      db = 'down';
    }
    return { status: 'ok' as const, db };
  });
};
