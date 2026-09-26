import { schema } from '@domar/db';
import { ACCOUNT_SLOTS } from '@domar/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireChart } from '../src/resources/accounting/chart.js';
import { createStaffUser, registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

let t: Awaited<ReturnType<typeof createTestApp>>;
let owner: string;
let readonlyCookie: string;

beforeAll(async () => {
  t = await createTestApp();
  const reg = await registerTenant(t.app, 'acct-chart');
  owner = reg.cookie;
  readonlyCookie = (await createStaffUser(t.app, owner, 'acct-chart', { email: 'r@acct-chart.mk', firstName: 'R', lastName: 'O', role: 'readonly' })).cookie;
});
afterAll(async () => { await t.close(); });

// R1: `packages/db` (the `account_slot` pg enum) and `@domar/domain` (`ACCOUNT_SLOTS`) each keep
// their own hand-written list of slots. `apps/api` is the only package that imports both, so this
// is the one place a drift between them would be caught before it reaches production.
describe('the account_slot enum', () => {
  it('matches ACCOUNT_SLOTS from @domar/domain, in the same order', () => {
    expect(schema.accountSlot.enumValues).toEqual(ACCOUNT_SLOTS);
  });
});

describe('GET /api/account-codes', () => {
  it('starts empty and names every unmapped slot', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/account-codes', headers: { cookie: owner } });
    expect(res.statusCode).toBe(200);
    expect(res.json().rows).toEqual([]);
    expect(res.json().missing).toEqual([
      'owner_receivable', 'revenue_service', 'revenue_management_fee', 'revenue_reserve_fund',
      'vat_output', 'cash_regular', 'cash_reserve', 'expense_default', 'opening_balance',
    ].map((slot) => ({ slot, reason: 'absent' })));
  });

  it('is readable by a readonly user', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/account-codes', headers: { cookie: readonlyCookie } });
    expect(res.statusCode).toBe(200);
  });
});

describe('PUT /api/account-codes/:slot', () => {
  it('maps a slot, then rewrites the same row rather than adding a second', async () => {
    const first = await t.app.inject({
      method: 'PUT', url: '/api/account-codes/owner_receivable', headers: { cookie: owner },
      payload: { code: '1200', name: 'Побарувања од купувачи' },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ slot: 'owner_receivable', code: '1200', isActive: true });
    const second = await t.app.inject({
      method: 'PUT', url: '/api/account-codes/owner_receivable', headers: { cookie: owner },
      payload: { code: '1201', name: 'Побарувања од сопственици' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
    const list = await t.app.inject({ method: 'GET', url: '/api/account-codes', headers: { cookie: owner } });
    expect(list.json().rows).toHaveLength(1);
    expect(list.json().rows[0].code).toBe('1201');
    expect(list.json().missing.some((m: { slot: string }) => m.slot === 'owner_receivable')).toBe(false);
  });

  it('rejects an unknown slot and an empty code', async () => {
    expect((await t.app.inject({ method: 'PUT', url: '/api/account-codes/petty_cash', headers: { cookie: owner }, payload: { code: '1', name: 'x' } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'PUT', url: '/api/account-codes/vat_output', headers: { cookie: owner }, payload: { code: '  ', name: 'x' } })).statusCode).toBe(400);
  });

  it('is refused to a readonly user', async () => {
    const res = await t.app.inject({ method: 'PUT', url: '/api/account-codes/vat_output', headers: { cookie: readonlyCookie }, payload: { code: '4700', name: 'ДДВ' } });
    expect(res.statusCode).toBe(403);
  });

  it('writes an audit row inside the transaction', async () => {
    await t.app.inject({ method: 'PUT', url: '/api/account-codes/cash_regular', headers: { cookie: owner }, payload: { code: '1000', name: 'Жиро сметка' } });
    const rows = await t.db.query.auditLogs.findMany({});
    expect(rows.some((r) => r.action === 'account_code.put' && r.entityType === 'account_code')).toBe(true);
  });

  it('resolves two concurrent writes to the same slot into one row, not a rival', async () => {
    const reg = await registerTenant(t.app, 'acct-chart-race');
    const [r1, r2] = await Promise.all([
      t.app.inject({ method: 'PUT', url: '/api/account-codes/cash_regular', headers: { cookie: reg.cookie }, payload: { code: '1000', name: 'A' } }),
      t.app.inject({ method: 'PUT', url: '/api/account-codes/cash_regular', headers: { cookie: reg.cookie }, payload: { code: '1001', name: 'B' } }),
    ]);
    expect([r1.statusCode, r2.statusCode]).toEqual([200, 200]);
    const list = await t.app.inject({ method: 'GET', url: '/api/account-codes', headers: { cookie: reg.cookie } });
    expect(list.json().rows.filter((r: { slot: string }) => r.slot === 'cash_regular')).toHaveLength(1);
  });
});

describe('a supplier names its own expense account', () => {
  it('accepts a code of this tenant and refuses one of another', async () => {
    const code = (await t.app.inject({ method: 'PUT', url: '/api/account-codes/expense_default', headers: { cookie: owner }, payload: { code: '4000', name: 'Трошоци' } })).json();
    const created = await t.app.inject({ method: 'POST', url: '/api/suppliers', headers: { cookie: owner }, payload: { name: 'ЕВН', accountCodeId: code.id } });
    expect(created.statusCode).toBe(201);
    expect(created.json().accountCodeId).toBe(code.id);

    const other = await registerTenant(t.app, 'acct-chart-2');
    const theirs = (await t.app.inject({ method: 'PUT', url: '/api/account-codes/expense_default', headers: { cookie: other.cookie }, payload: { code: '4000', name: 'Трошоци' } })).json();
    const rejected = await t.app.inject({ method: 'POST', url: '/api/suppliers', headers: { cookie: owner }, payload: { name: 'Туѓ', accountCodeId: theirs.id } });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe('invalid_reference');
  });
});

// R3: a slot that is configured but disabled must be told apart from one nobody has touched, or
// the fix for "disabled" looks identical to the fix for "never mapped" and the caller re-enters a
// code that is already there.
describe('requireChart', () => {
  it('names why each unusable slot is unusable: absent, switched off, or blank', async () => {
    const reg = await registerTenant(t.app, 'acct-chart-reasons');
    const ctx = { tenantId: reg.tenantId, userId: reg.userId, role: 'owner' as const };

    await t.app.inject({
      method: 'PUT', url: '/api/account-codes/revenue_service', headers: { cookie: reg.cookie },
      payload: { code: '7000', name: 'Приходи', isActive: false },
    });
    // A blank code is reachable only from data the API itself refuses to write (empty codes are
    // rejected by `accountCodePut`), so it is seeded directly to exercise that branch.
    await t.db.insert(schema.accountCodes).values({ tenantId: reg.tenantId, slot: 'vat_output', code: '', name: 'ДДВ' });
    // Every other slot, `owner_receivable` included, is left entirely unmapped.

    await expect(requireChart(t.db, ctx)).rejects.toMatchObject({
      statusCode: 409,
      code: 'chart_incomplete',
      details: {
        missing: expect.arrayContaining([
          { slot: 'owner_receivable', reason: 'absent' },
          { slot: 'revenue_service', reason: 'inactive' },
          { slot: 'vat_output', reason: 'blank_code' },
        ]),
      },
    });
  });
});
