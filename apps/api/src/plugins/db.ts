import type { Db } from '@domar/db';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import type postgres from 'postgres';

declare module 'fastify' {
  interface FastifyInstance { db: Db; sql: postgres.Sql }
  interface FastifyRequest { db: Db }
}

const plugin: FastifyPluginAsync<{ db: Db; sql: postgres.Sql }> = async (app, opts) => {
  app.decorate('db', opts.db);
  app.decorate('sql', opts.sql);
  app.decorateRequest('db', { getter: () => opts.db });
};

export const dbPlugin = fp(plugin, { name: 'db' });
