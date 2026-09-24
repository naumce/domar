import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from '../src/test-db.js';

const TENANT_SCOPED_EXEMPT = new Set(['tenants', 'sessions', 'owner_accounts', 'owner_sessions', '__drizzle_migrations']);

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
      'payments', 'bank_statements', 'statement_lines', 'reminders', 'email_log',
      'owner_accounts', 'owner_sessions', 'owner_contact_links', 'portal_invites'])
      expect(names).toContain(n);
  });

  it('tenants have a timezone default and invoice_sequences a primary key', async () => {
    const [tz] = await t!.sql<{ column_default: string }[]>`select column_default from information_schema.columns where table_name='tenants' and column_name='timezone'`;
    expect(tz!.column_default).toContain('Europe/Skopje');
    const pk = await t!.sql`select 1 from information_schema.table_constraints where table_name='invoice_sequences' and constraint_type='PRIMARY KEY'`;
    expect(pk.length).toBe(1);
  });

  it('users carry an is_active flag defaulting to true', async () => {
    const [col] = await t!.sql<{ data_type: string; column_default: string; is_nullable: string }[]>`
      select data_type, column_default, is_nullable from information_schema.columns
      where table_name = 'users' and column_name = 'is_active'`;
    expect(col).toBeDefined();
    expect(col!.data_type).toBe('boolean');
    expect(col!.column_default).toBe('true');
    expect(col!.is_nullable).toBe('NO');
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

  it('reminders store the covered invoice ids and the rendered document', async () => {
    const cols = await t!.sql<{ column_name: string; data_type: string; is_nullable: string }[]>`
      select column_name, data_type, is_nullable from information_schema.columns where table_name = 'reminders'`;
    const by = Object.fromEntries(cols.map((c) => [c.column_name, c]));
    expect(by['invoice_ids']!.data_type).toBe('ARRAY');
    expect(by['total_outstanding_minor']!.data_type).toBe('bigint');
    expect(by['document_html']!.is_nullable).toBe('NO');
    expect(by['sent_at']!.is_nullable).toBe('YES');
    const idx = await t!.sql<{ indexdef: string }[]>`select indexdef from pg_indexes where tablename = 'reminders' and indexname = 'reminders_tenant_building_idx'`;
    expect(idx[0]!.indexdef).toContain('(tenant_id, building_id, created_at)');
  });

  it('email_log records every delivery attempt', async () => {
    const cols = await t!.sql<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_name = 'email_log' order by 1`;
    expect(cols.map((c) => c.column_name)).toEqual(
      ['created_at', 'error', 'id', 'ref_id', 'ref_type', 'sent_at', 'status', 'subject', 'template', 'tenant_id', 'to_address']);
    const idx = await t!.sql<{ indexdef: string }[]>`select indexdef from pg_indexes where tablename = 'email_log' and indexname = 'email_log_tenant_created_idx'`;
    expect(idx[0]!.indexdef).toContain('(tenant_id, created_at)');
  });

  it('owner accounts are global and their email is unique', async () => {
    const cols = await t!.sql<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns where table_name = 'owner_accounts' order by 1`;
    expect(cols.map((c) => c.column_name)).toEqual(['created_at', 'email', 'id', 'is_active', 'password_hash', 'updated_at']);
    const idx = await t!.sql<{ indexdef: string }[]>`select indexdef from pg_indexes where tablename = 'owner_accounts'`;
    expect(idx.some((i) => i.indexdef.includes('UNIQUE') && i.indexdef.includes('(email)'))).toBe(true);
    const sess = await t!.sql<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_name = 'owner_sessions' and column_name = 'tenant_id'`;
    expect(sess.length).toBe(0);
  });

  it('owner_contact_links bridge one account to one contact', async () => {
    const cols = await t!.sql<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns where table_name = 'owner_contact_links' order by 1`;
    expect(cols.map((c) => c.column_name)).toEqual(['contact_id', 'id', 'linked_at', 'owner_account_id', 'tenant_id']);
    expect(cols.every((c) => c.is_nullable === 'NO')).toBe(true);
    const idx = await t!.sql<{ indexdef: string }[]>`select indexdef from pg_indexes where tablename = 'owner_contact_links'`;
    expect(idx.some((i) => i.indexdef.includes('UNIQUE') && i.indexdef.includes('(owner_account_id, contact_id)'))).toBe(true);
    expect(idx.some((i) => i.indexdef.includes('(tenant_id, contact_id)'))).toBe(true);
  });

  it('portal_invites store a hashed code with an expiry', async () => {
    const cols = await t!.sql<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns where table_name = 'portal_invites' order by 1`;
    expect(cols.map((c) => c.column_name)).toEqual(['code_hash', 'contact_id', 'created_at', 'created_by', 'expires_at', 'failed_attempts', 'id', 'tenant_id', 'used_at']);
    const by = Object.fromEntries(cols.map((c) => [c.column_name, c]));
    expect(by['used_at']!.is_nullable).toBe('YES');
    expect(by['created_by']!.is_nullable).toBe('YES');
    expect(by['expires_at']!.is_nullable).toBe('NO');
    expect(by['failed_attempts']!.is_nullable).toBe('NO');
    const idx = await t!.sql<{ indexdef: string }[]>`select indexdef from pg_indexes where tablename = 'portal_invites'`;
    expect(idx.some((i) => i.indexdef.includes('UNIQUE') && i.indexdef.includes('(code_hash)'))).toBe(true);
    expect(idx.some((i) => i.indexdef.includes('(tenant_id, contact_id, created_at)'))).toBe(true);
  });
});
