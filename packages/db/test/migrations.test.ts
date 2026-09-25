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

  it('creates the compliance, document, supplier and contract tables', async () => {
    const rows = await t!.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public' order by 1`;
    const names = rows.map((r) => r.table_name);
    for (const n of ['legal_events', 'documents', 'suppliers', 'building_contracts']) expect(names).toContain(n);
  });

  it('legal_events are append-only rows with evidence', async () => {
    const cols = await t!.sql<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]>`
      select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'legal_events' order by 1`;
    expect(cols.map((c) => c.column_name)).toEqual(
      ['building_id', 'created_at', 'created_by', 'due_at', 'evidence', 'id', 'kind', 'occurred_at', 'ref_id', 'ref_type', 'seq', 'tenant_id']);
    const by = Object.fromEntries(cols.map((c) => [c.column_name, c]));
    expect(by['evidence']!.data_type).toBe('jsonb');
    expect(by['evidence']!.is_nullable).toBe('NO');
    expect(by['due_at']!.is_nullable).toBe('YES');
    expect(by['ref_id']!.is_nullable).toBe('YES');
    expect(by['created_by']!.is_nullable).toBe('YES');
    const kinds = await t!.sql<{ enumlabel: string }[]>`
      select enumlabel from pg_enum e join pg_type ty on ty.oid = e.enumtypid where ty.typname = 'legal_event_kind' order by e.enumsortorder`;
    expect(kinds.map((k) => k.enumlabel)).toEqual([
      'invoice_published', 'reminder_sent', 'assembly_invited', 'assembly_held',
      'annual_report_issued', 'handover_report_issued', 'fund_statement_available', 'extraordinary_cost_distributed']);
    const idx = await t!.sql<{ indexdef: string }[]>`select indexdef from pg_indexes where tablename = 'legal_events'`;
    expect(idx.some((i) => i.indexdef.includes('(tenant_id, building_id, occurred_at)'))).toBe(true);
    expect(idx.some((i) => i.indexdef.includes('(tenant_id, kind, occurred_at)'))).toBe(true);
  });

  it('documents carry a sha256, a size and a storage key', async () => {
    const cols = await t!.sql<{ column_name: string; data_type: string; is_nullable: string }[]>`
      select column_name, data_type, is_nullable from information_schema.columns where table_name = 'documents' order by 1`;
    expect(cols.map((c) => c.column_name)).toEqual(
      ['building_id', 'created_at', 'file_name', 'id', 'kind', 'mime', 'sha256', 'size_bytes', 'storage_key', 'tenant_id', 'title', 'uploaded_by']);
    const by = Object.fromEntries(cols.map((c) => [c.column_name, c]));
    expect(by['building_id']!.is_nullable).toBe('YES');
    expect(by['size_bytes']!.data_type).toBe('bigint');
    expect(by['sha256']!.is_nullable).toBe('NO');
    const idx = await t!.sql<{ indexdef: string }[]>`select indexdef from pg_indexes where tablename = 'documents'`;
    expect(idx.some((i) => i.indexdef.includes('UNIQUE') && i.indexdef.includes('(storage_key)'))).toBe(true);
    expect(idx.some((i) => i.indexdef.includes('(tenant_id, building_id, created_at)'))).toBe(true);
  });

  it('building_contracts hold the dates the Art. 30 clock reads', async () => {
    const cols = await t!.sql<{ column_name: string; data_type: string; is_nullable: string }[]>`
      select column_name, data_type, is_nullable from information_schema.columns where table_name = 'building_contracts' order by 1`;
    const by = Object.fromEntries(cols.map((c) => [c.column_name, c]));
    expect(by['starts_on']!.data_type).toBe('date');
    expect(by['ends_on']!.data_type).toBe('date');
    expect(by['ends_on']!.is_nullable).toBe('YES');
    expect(by['supplier_id']!.is_nullable).toBe('YES');
    expect(by['amount_minor']!.data_type).toBe('bigint');
    const kinds = await t!.sql<{ enumlabel: string }[]>`
      select enumlabel from pg_enum e join pg_type ty on ty.oid = e.enumtypid where ty.typname = 'contract_kind' order by e.enumsortorder`;
    expect(kinds.map((k) => k.enumlabel)).toEqual(['management', 'service', 'insurance', 'other']);
  });

  it('expenses can name a supplier and a document', async () => {
    const cols = await t!.sql<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns where table_name = 'expenses' and column_name in ('supplier_id', 'document_id')`;
    expect(cols.length).toBe(2);
    expect(cols.every((c) => c.is_nullable === 'YES')).toBe(true);
  });

  it('billing periods carry a kind and only one regular period per month', async () => {
    const [kind] = await t!.sql<{ column_default: string; is_nullable: string }[]>`
      select column_default, is_nullable from information_schema.columns where table_name = 'billing_periods' and column_name = 'kind'`;
    expect(kind!.is_nullable).toBe('NO');
    expect(kind!.column_default).toContain('regular');
    const kinds = await t!.sql<{ enumlabel: string }[]>`
      select enumlabel from pg_enum e join pg_type ty on ty.oid = e.enumtypid where ty.typname = 'period_kind' order by e.enumsortorder`;
    expect(kinds.map((k) => k.enumlabel)).toEqual(['regular', 'extraordinary']);
    const idx = await t!.sql<{ indexname: string; indexdef: string }[]>`select indexname, indexdef from pg_indexes where tablename = 'billing_periods'`;
    expect(idx.some((i) => i.indexname === 'billing_periods_building_period_idx')).toBe(false);
    const partial = idx.find((i) => i.indexname === 'billing_periods_building_regular_period_idx');
    expect(partial).toBeDefined();
    expect(partial!.indexdef).toContain('UNIQUE');
    expect(partial!.indexdef).toContain('(building_id, period)');
    expect(partial!.indexdef).toContain("WHERE (kind = 'regular'::period_kind)");
    const [basis] = await t!.sql<{ udt_name: string; is_nullable: string }[]>`
      select udt_name, is_nullable from information_schema.columns where table_name = 'billing_periods' and column_name = 'distribution_basis'`;
    expect(basis!.udt_name).toBe('share_basis');
    expect(basis!.is_nullable).toBe('YES');
  });

  it('creates the assembly tables', async () => {
    const rows = await t!.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public' order by 1`;
    const names = rows.map((r) => r.table_name);
    for (const n of ['assemblies', 'assembly_invitations', 'assembly_attendance', 'assembly_decisions', 'assembly_votes'])
      expect(names).toContain(n);
  });

  it('an assembly carries its agenda, its quorum basis and its late-invitation stamp', async () => {
    const cols = await t!.sql<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]>`
      select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'assemblies' order by 1`;
    expect(cols.map((c) => c.column_name)).toEqual([
      'agenda', 'building_id', 'cancel_reason', 'cancelled_at', 'created_at', 'created_by', 'held_at', 'id',
      'invitation_html', 'invited_at', 'late_invitation', 'late_reason', 'location', 'minutes_document_id',
      'minutes_html', 'quorum_basis', 'scheduled_at', 'status', 'tenant_id', 'updated_at']);
    const by = Object.fromEntries(cols.map((c) => [c.column_name, c]));
    expect(by['agenda']!.data_type).toBe('jsonb');
    expect(by['agenda']!.is_nullable).toBe('NO');
    expect(by['scheduled_at']!.is_nullable).toBe('NO');
    expect(by['held_at']!.is_nullable).toBe('YES');
    expect(by['invited_at']!.is_nullable).toBe('YES');
    expect(by['minutes_document_id']!.is_nullable).toBe('YES');
    expect(by['late_invitation']!.column_default).toBe('false');
    expect(by['status']!.column_default).toContain('draft');
    expect(by['quorum_basis']!.column_default).toContain('share');
    const status = await t!.sql<{ enumlabel: string }[]>`
      select enumlabel from pg_enum e join pg_type ty on ty.oid = e.enumtypid where ty.typname = 'assembly_status' order by e.enumsortorder`;
    expect(status.map((s) => s.enumlabel)).toEqual(['draft', 'invited', 'held', 'cancelled']);
    const basis = await t!.sql<{ enumlabel: string }[]>`
      select enumlabel from pg_enum e join pg_type ty on ty.oid = e.enumtypid where ty.typname = 'quorum_basis' order by e.enumsortorder`;
    expect(basis.map((s) => s.enumlabel)).toEqual(['share', 'count']);
    const idx = await t!.sql<{ indexdef: string }[]>`select indexdef from pg_indexes where tablename = 'assemblies'`;
    expect(idx.some((i) => i.indexdef.includes('(tenant_id, building_id, scheduled_at)'))).toBe(true);
    expect(idx.some((i) => i.indexdef.includes('(tenant_id, status, scheduled_at)'))).toBe(true);
  });

  it('one invitation per owner contact, with its channel and its email log', async () => {
    const cols = await t!.sql<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns where table_name = 'assembly_invitations' order by 1`;
    expect(cols.map((c) => c.column_name)).toEqual(
      ['assembly_id', 'channel', 'contact_id', 'created_at', 'email_log_id', 'error', 'id', 'sent_at', 'status', 'tenant_id']);
    const by = Object.fromEntries(cols.map((c) => [c.column_name, c]));
    expect(by['sent_at']!.is_nullable).toBe('YES');
    expect(by['email_log_id']!.is_nullable).toBe('YES');
    const channels = await t!.sql<{ enumlabel: string }[]>`
      select enumlabel from pg_enum e join pg_type ty on ty.oid = e.enumtypid where ty.typname = 'assembly_channel' order by e.enumsortorder`;
    expect(channels.map((c) => c.enumlabel)).toEqual(['email', 'letter']);
    const statuses = await t!.sql<{ enumlabel: string }[]>`
      select enumlabel from pg_enum e join pg_type ty on ty.oid = e.enumtypid where ty.typname = 'assembly_invitation_status' order by e.enumsortorder`;
    expect(statuses.map((c) => c.enumlabel)).toEqual(['pending', 'sent', 'failed', 'printed', 'cancelled']);
    const idx = await t!.sql<{ indexdef: string }[]>`select indexdef from pg_indexes where tablename = 'assembly_invitations'`;
    expect(idx.some((i) => i.indexdef.includes('UNIQUE') && i.indexdef.includes('(assembly_id, contact_id)'))).toBe(true);
    expect(idx.some((i) => i.indexdef.includes('(tenant_id, assembly_id, created_at)'))).toBe(true);
  });

  it('attendance freezes the weight each owner carried at the assembly', async () => {
    const cols = await t!.sql<{ column_name: string; data_type: string; is_nullable: string }[]>`
      select column_name, data_type, is_nullable from information_schema.columns where table_name = 'assembly_attendance' order by 1`;
    expect(cols.map((c) => c.column_name)).toEqual(
      ['assembly_id', 'contact_id', 'created_at', 'id', 'present', 'proxy_name', 'tenant_id', 'weight_bp']);
    const by = Object.fromEntries(cols.map((c) => [c.column_name, c]));
    expect(by['weight_bp']!.data_type).toBe('integer');
    expect(by['weight_bp']!.is_nullable).toBe('NO');
    expect(by['proxy_name']!.is_nullable).toBe('YES');
    const idx = await t!.sql<{ indexdef: string }[]>`select indexdef from pg_indexes where tablename = 'assembly_attendance'`;
    expect(idx.some((i) => i.indexdef.includes('UNIQUE') && i.indexdef.includes('(assembly_id, contact_id)'))).toBe(true);
  });

  it('a decision stores the tally it was decided by', async () => {
    const cols = await t!.sql<{ column_name: string; data_type: string; is_nullable: string }[]>`
      select column_name, data_type, is_nullable from information_schema.columns where table_name = 'assembly_decisions' order by 1`;
    expect(cols.map((c) => c.column_name)).toEqual([
      'abstain_weight', 'against_weight', 'assembly_id', 'basis_total', 'created_at', 'for_weight', 'id',
      'present_weight', 'quorum_reached', 'result', 'sort_order', 'tenant_id', 'text', 'title', 'updated_at']);
    const by = Object.fromEntries(cols.map((c) => [c.column_name, c]));
    for (const n of ['for_weight', 'against_weight', 'abstain_weight', 'present_weight', 'basis_total']) {
      expect(by[n]!.data_type, n).toBe('integer');
      expect(by[n]!.is_nullable, n).toBe('NO');
    }
    const results = await t!.sql<{ enumlabel: string }[]>`
      select enumlabel from pg_enum e join pg_type ty on ty.oid = e.enumtypid where ty.typname = 'decision_result' order by e.enumsortorder`;
    expect(results.map((c) => c.enumlabel)).toEqual(['pending', 'passed', 'rejected', 'no_quorum']);
  });

  it('a contact can hold exactly one vote per decision', async () => {
    const cols = await t!.sql<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_name = 'assembly_votes' order by 1`;
    expect(cols.map((c) => c.column_name)).toEqual(
      ['assembly_id', 'cast_at', 'choice', 'contact_id', 'created_at', 'decision_id', 'id', 'tenant_id', 'via']);
    const choices = await t!.sql<{ enumlabel: string }[]>`
      select enumlabel from pg_enum e join pg_type ty on ty.oid = e.enumtypid where ty.typname = 'vote_choice' order by e.enumsortorder`;
    expect(choices.map((c) => c.enumlabel)).toEqual(['for', 'against', 'abstain']);
    const via = await t!.sql<{ enumlabel: string }[]>`
      select enumlabel from pg_enum e join pg_type ty on ty.oid = e.enumtypid where ty.typname = 'vote_via' order by e.enumsortorder`;
    expect(via.map((c) => c.enumlabel)).toEqual(['portal', 'paper']);
    const idx = await t!.sql<{ indexdef: string }[]>`select indexdef from pg_indexes where tablename = 'assembly_votes'`;
    expect(idx.some((i) => i.indexdef.includes('UNIQUE') && i.indexdef.includes('(decision_id, contact_id)'))).toBe(true);
    expect(idx.some((i) => i.indexdef.includes('(tenant_id, assembly_id, contact_id)'))).toBe(true);
  });

  it('creates the maintenance tables', async () => {
    const rows = await t!.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public' order by 1`;
    const names = rows.map((r) => r.table_name);
    for (const n of ['maintenance_requests', 'maintenance_events', 'maintenance_photos']) expect(names).toContain(n);
  });

  it('a maintenance request carries its reporter, its assignee and its cost', async () => {
    const cols = await t!.sql<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]>`
      select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'maintenance_requests' order by 1`;
    expect(cols.map((c) => c.column_name)).toEqual([
      'assignee_user_id', 'building_id', 'category', 'closed_at', 'cost_minor', 'created_at', 'description',
      'expense_id', 'fund', 'id', 'priority', 'reported_by_contact_id', 'reported_by_user_id', 'status',
      'supplier_id', 'tenant_id', 'title', 'unit_id', 'updated_at']);
    const by = Object.fromEntries(cols.map((c) => [c.column_name, c]));
    expect(by['cost_minor']!.data_type).toBe('bigint');
    expect(by['cost_minor']!.is_nullable).toBe('YES');
    expect(by['fund']!.is_nullable).toBe('YES');
    expect(by['expense_id']!.is_nullable).toBe('YES');
    expect(by['unit_id']!.is_nullable).toBe('YES');
    expect(by['assignee_user_id']!.is_nullable).toBe('YES');
    expect(by['reported_by_user_id']!.is_nullable).toBe('YES');
    expect(by['reported_by_contact_id']!.is_nullable).toBe('YES');
    expect(by['status']!.column_default).toContain('new');
    expect(by['priority']!.column_default).toContain('normal');
    const status = await t!.sql<{ enumlabel: string }[]>`
      select enumlabel from pg_enum e join pg_type ty on ty.oid = e.enumtypid where ty.typname = 'maintenance_status' order by e.enumsortorder`;
    expect(status.map((s) => s.enumlabel)).toEqual(['new', 'triaged', 'assigned', 'in_progress', 'done', 'rejected']);
    const priority = await t!.sql<{ enumlabel: string }[]>`
      select enumlabel from pg_enum e join pg_type ty on ty.oid = e.enumtypid where ty.typname = 'maintenance_priority' order by e.enumsortorder`;
    expect(priority.map((s) => s.enumlabel)).toEqual(['low', 'normal', 'high', 'urgent']);
    const category = await t!.sql<{ enumlabel: string }[]>`
      select enumlabel from pg_enum e join pg_type ty on ty.oid = e.enumtypid where ty.typname = 'maintenance_category' order by e.enumsortorder`;
    expect(category.map((s) => s.enumlabel)).toEqual(['plumbing', 'electrical', 'lift', 'heating', 'cleaning', 'common_area', 'other']);
    const idx = await t!.sql<{ indexdef: string }[]>`select indexdef from pg_indexes where tablename = 'maintenance_requests'`;
    expect(idx.some((i) => i.indexdef.includes('(tenant_id, building_id, created_at)'))).toBe(true);
    expect(idx.some((i) => i.indexdef.includes('(tenant_id, status, created_at)'))).toBe(true);
    expect(idx.some((i) => i.indexdef.includes('(tenant_id, assignee_user_id, created_at)'))).toBe(true);
    expect(idx.some((i) => i.indexdef.includes('(tenant_id, reported_by_contact_id, created_at)'))).toBe(true);
  });

  it('exactly one reporter is a database check, not a convention', async () => {
    const [chk] = await t!.sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'maintenance_requests'::regclass and contype = 'c' and conname = 'maintenance_requests_reporter_chk'`;
    expect(chk).toBeDefined();
    expect(chk!.def.replace(/\s+/g, ' ')).toContain('num_nonnulls');

    // The check really fires: two reporters and no reporter are both refused.
    const [tenant] = await t!.sql<{ id: string }[]>`
      insert into tenants (slug, name, country_code, currency, locale)
      values ('mig-maint', 'Mig Maint', 'mk', 'MKD', 'mk-MK') returning id`;
    const [building] = await t!.sql<{ id: string }[]>`
      insert into buildings (tenant_id, name, country_code) values (${tenant!.id}, 'Зграда', 'mk') returning id`;
    const [user] = await t!.sql<{ id: string }[]>`
      insert into users (tenant_id, email, password_hash, first_name, last_name, role)
      values (${tenant!.id}, 'm@mig.mk', 'x', 'M', 'M', 'owner') returning id`;
    const [contact] = await t!.sql<{ id: string }[]>`
      insert into contacts (tenant_id, last_name) values (${tenant!.id}, 'Сопственик') returning id`;
    const insert = (reportedByUser: string | null, reportedByContact: string | null) => t!.sql`
      insert into maintenance_requests (tenant_id, building_id, title, description, category, reported_by_user_id, reported_by_contact_id)
      values (${tenant!.id}, ${building!.id}, 'Т', 'О', 'other', ${reportedByUser}, ${reportedByContact})`;
    await expect(insert(null, null)).rejects.toThrow(/maintenance_requests_reporter_chk/);
    await expect(insert(user!.id, contact!.id)).rejects.toThrow(/maintenance_requests_reporter_chk/);
    await expect(insert(user!.id, null)).resolves.toBeDefined();
    await t!.sql`delete from tenants where id = ${tenant!.id}`;
  });

  it('maintenance events record who said what, and how visible it is', async () => {
    const cols = await t!.sql<{ column_name: string; is_nullable: string; column_default: string | null }[]>`
      select column_name, is_nullable, column_default from information_schema.columns where table_name = 'maintenance_events' order by 1`;
    expect(cols.map((c) => c.column_name)).toEqual([
      'author_contact_id', 'author_user_id', 'created_at', 'from_status', 'id', 'kind',
      'maintenance_request_id', 'note', 'tenant_id', 'to_status', 'visibility']);
    const by = Object.fromEntries(cols.map((c) => [c.column_name, c]));
    expect(by['note']!.is_nullable).toBe('NO');
    expect(by['from_status']!.is_nullable).toBe('YES');
    expect(by['to_status']!.is_nullable).toBe('YES');
    expect(by['visibility']!.column_default).toContain('internal');
    const kinds = await t!.sql<{ enumlabel: string }[]>`
      select enumlabel from pg_enum e join pg_type ty on ty.oid = e.enumtypid where ty.typname = 'maintenance_event_kind' order by e.enumsortorder`;
    expect(kinds.map((k) => k.enumlabel)).toEqual(['created', 'status_changed', 'assigned', 'comment', 'photo_added']);
    const vis = await t!.sql<{ enumlabel: string }[]>`
      select enumlabel from pg_enum e join pg_type ty on ty.oid = e.enumtypid where ty.typname = 'maintenance_visibility' order by e.enumsortorder`;
    expect(vis.map((v) => v.enumlabel)).toEqual(['internal', 'owner']);
    const idx = await t!.sql<{ indexdef: string }[]>`select indexdef from pg_indexes where tablename = 'maintenance_events'`;
    expect(idx.some((i) => i.indexdef.includes('(tenant_id, maintenance_request_id, created_at)'))).toBe(true);
  });

  it('a photo belongs to exactly one request and dies with its document', async () => {
    const cols = await t!.sql<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns where table_name = 'maintenance_photos' order by 1`;
    expect(cols.map((c) => c.column_name)).toEqual([
      'created_at', 'document_id', 'id', 'maintenance_request_id', 'tenant_id', 'uploaded_by_contact_id', 'uploaded_by_user_id']);
    const idx = await t!.sql<{ indexdef: string }[]>`select indexdef from pg_indexes where tablename = 'maintenance_photos'`;
    expect(idx.some((i) => i.indexdef.includes('UNIQUE') && i.indexdef.includes('(document_id)'))).toBe(true);
    expect(idx.some((i) => i.indexdef.includes('(tenant_id, maintenance_request_id, created_at)'))).toBe(true);
    const [fk] = await t!.sql<{ delete_rule: string }[]>`
      select rc.delete_rule from information_schema.referential_constraints rc
      join information_schema.key_column_usage k on k.constraint_name = rc.constraint_name
      where k.table_name = 'maintenance_photos' and k.column_name = 'document_id'`;
    expect(fk!.delete_rule).toBe('CASCADE');
  });
});
