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
    for (const n of ['tenants', 'users', 'sessions', 'contacts', 'buildings', 'units', 'tax_rates', 'audit_logs',
      'services', 'building_services', 'reserve_fund_settings', 'expenses', 'billing_periods', 'period_lines', 'invoices', 'invoice_lines', 'postings', 'invoice_sequences',
      'payments', 'bank_statements', 'statement_lines'])
      expect(names).toContain(n);
  });

  it('tenants have a timezone default and invoice_sequences a primary key', async () => {
    const [tz] = await t!.sql<{ column_default: string }[]>`select column_default from information_schema.columns where table_name='tenants' and column_name='timezone'`;
    expect(tz!.column_default).toContain('Europe/Skopje');
    const pk = await t!.sql`select 1 from information_schema.table_constraints where table_name='invoice_sequences' and constraint_type='PRIMARY KEY'`;
    expect(pk.length).toBe(1);
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

  it('money columns on billing tables are bigint', async () => {
    const cols = await t!.sql<{ table_name: string; column_name: string; data_type: string }[]>`
      select table_name, column_name, data_type from information_schema.columns
      where table_schema = 'public' and table_name in ('period_lines','invoices','invoice_lines','postings','expenses','reserve_fund_settings','billing_periods','services','building_services')
        and column_name like '%_minor'`;
    expect(cols.length).toBeGreaterThan(10);
    for (const c of cols) expect(c.data_type, `${c.table_name}.${c.column_name}`).toBe('bigint');
  });
});
