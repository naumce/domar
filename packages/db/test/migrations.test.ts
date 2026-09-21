import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from '../src/test-db.js';

const TENANT_SCOPED_EXEMPT = new Set(['tenants', 'sessions', '__drizzle_migrations']);

describe('migrations', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.close();
  });

  it('creates the expected tables', async () => {
    const rows = await t!.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public' order by 1`;
    const names = rows.map((r) => r.table_name);
    for (const n of ['tenants', 'users', 'sessions', 'contacts', 'buildings', 'units', 'tax_rates', 'audit_logs'])
      expect(names).toContain(n);
  });

  it('every tenant-scoped table has tenant_id and an index starting with it', async () => {
    const tables = await t!.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`;
    for (const { table_name } of tables) {
      if (TENANT_SCOPED_EXEMPT.has(table_name)) continue;
      const col = await t!.sql`
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = ${table_name} and column_name = 'tenant_id' and is_nullable = 'NO'`;
      expect(col.length, `${table_name} lacks not-null tenant_id`).toBe(1);
      const idx = await t!.sql<{ indexdef: string }[]>`
        select indexdef from pg_indexes where schemaname = 'public' and tablename = ${table_name}`;
      const hasLeading = idx.some((i) => /\((tenant_id)[,)]/.test(i.indexdef));
      expect(hasLeading, `${table_name} lacks an index leading with tenant_id`).toBe(true);
    }
  });

  it('money columns are bigint and end with _minor', async () => {
    const cols = await t!.sql<{ table_name: string; column_name: string; data_type: string }[]>`
      select table_name, column_name, data_type from information_schema.columns
      where table_schema = 'public' and (column_name like '%_minor' or data_type in ('real','double precision'))`;
    for (const c of cols) {
      expect(c.data_type, `${c.table_name}.${c.column_name}`).toBe('bigint');
    }
  });
});
