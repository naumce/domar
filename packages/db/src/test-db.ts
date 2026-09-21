import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { createDb, type Db } from './client.js';
import { runMigrations } from './migrate.js';

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? 'postgres://domar:domar@localhost:54329/postgres';

/** Creates a throwaway database, runs migrations, returns a client. Call close() to drop it. */
export async function createTestDatabase(): Promise<{ url: string; db: Db; sql: postgres.Sql; close(): Promise<void> }> {
  const name = `domar_test_${randomBytes(6).toString('hex')}`;
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  await runMigrations(url.toString());
  const { db, sql } = createDb(url.toString());
  return {
    url: url.toString(),
    db,
    sql,
    async close() {
      await sql.end();
      await admin.unsafe(`drop database ${name} with (force)`);
      await admin.end();
    },
  };
}
