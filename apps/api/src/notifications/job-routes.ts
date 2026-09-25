import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { assertJobToken } from '../jobs/token.js';
import { drainNotifications, notificationRuntime } from './deliver.js';

export const drainResultOut = z.object({
  claimed: z.number().int(), pushed: z.number().int(), emailed: z.number().int(), failed: z.number().int(),
});

/** No session: the cron authenticates with the same shared token as the reminder job (spec §18.3). */
export const notificationJobRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post('/notifications', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, schema: { response: { 200: drainResultOut } } }, async (req) => {
    assertJobToken(app.config, req.headers);
    return drainNotifications(req.db, notificationRuntime(app));
  });
};
