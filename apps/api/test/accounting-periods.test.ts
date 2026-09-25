import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaffUser, registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

let t: Awaited<ReturnType<typeof createTestApp>>;
let cookie: string;
let readonlyCookie: string;
let buildingId: string;
let periodId: string;

beforeAll(async () => {
  t = await createTestApp();
  const reg = await registerTenant(t.app, 'acct-periods');
  cookie = reg.cookie;
  readonlyCookie = (await createStaffUser(t.app, cookie, 'acct-periods', { email: 'r@acct-periods.mk', firstName: 'R', lastName: 'O', role: 'readonly' })).cookie;
  const post = async (url: string, payload: unknown = {}) => {
    const res = await t.app.inject({ method: 'POST', url, headers: { cookie }, payload: payload as never });
    if (res.statusCode >= 300) throw new Error(`${url} → ${res.body}`);
    return res.json();
  };
  const rates = (await t.app.inject({ method: 'GET', url: '/api/tax-rates', headers: { cookie } })).json();
  const vatId = rates.rows.find((r: { rateBp: number }) => r.rateBp === 1800).id;
  const owner = await post('/api/contacts', { firstName: 'Петар', lastName: 'Петров' });
  const building = await post('/api/buildings', { name: 'Македонија 3', address: 'Македонија 3', city: 'Скопје', postalCode: '1000' });
  buildingId = building.id;
  await post(`/api/buildings/${buildingId}/units`, { label: '1', kind: 'apartment', areaM2: 40, ownerContactId: owner.id });
  const service = await post('/api/services', { name: 'Чистење', pricing: 'fixed_per_unit', defaultPriceMinor: 100000, taxRateId: vatId, appliesTo: ['apartment'] });
  await post(`/api/buildings/${buildingId}/services`, { serviceId: service.id, startsPeriod: '2026-01' });
  const period = await post(`/api/buildings/${buildingId}/periods`, { period: '2026-09' });
  periodId = period.id;
  await post(`/api/buildings/${buildingId}/periods/${periodId}/generate`);
  await post(`/api/buildings/${buildingId}/periods/${periodId}/publish`);
  const slots: [string, string, string][] = [
    ['owner_receivable', '1200', 'Побарувања'], ['revenue_service', '7400', 'Приходи од услуги'],
    ['revenue_management_fee', '7410', 'Приходи од управување'], ['revenue_reserve_fund', '7420', 'Резервен фонд'],
    ['vat_output', '4700', 'ДДВ на излез'], ['cash_regular', '1000', 'Редовна сметка'],
    ['cash_reserve', '1001', 'Резервна сметка'], ['expense_default', '4000', 'Трошоци'], ['opening_balance', '9000', 'Почетна состојба'],
  ];
  for (const [slot, code, name] of slots) {
    await t.app.inject({ method: 'PUT', url: `/api/account-codes/${slot}`, headers: { cookie }, payload: { code, name } });
  }
});
afterAll(async () => { await t.close(); });

const thisPeriod = () => new Date().toISOString().slice(0, 7);

describe('closing a period', () => {
  it('is refused to a readonly user', async () => {
    const res = await t.app.inject({ method: 'POST', url: `/api/accounting/periods/${thisPeriod()}/close`, headers: { cookie: readonlyCookie } });
    expect(res.statusCode).toBe(403);
  });

  it('records the totals, who closed it and when', async () => {
    const res = await t.app.inject({ method: 'POST', url: `/api/accounting/periods/${thisPeriod()}/close`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const row = res.json();
    expect(row.period).toBe(thisPeriod());
    expect(row.debitTotalMinor).toBe(row.creditTotalMinor);
    expect(row.debitTotalMinor).toBe(118000);
    expect(row.entryCount).toBe(1);
    expect(row.closedAt).toBeTruthy();
    expect(row.closedByName).toBe('O acct-periods');
  });

  it('adds no refusal anywhere else: a payment into the closed period still records', async () => {
    const invoices = (await t.app.inject({ method: 'GET', url: `/api/invoices?buildingId=${buildingId}`, headers: { cookie } })).json();
    const res = await t.app.inject({
      method: 'POST', url: `/api/invoices/${invoices.rows[0].id}/payments`, headers: { cookie },
      payload: { amountMinor: 18000, method: 'cash', paidAt: new Date().toISOString() },
    });
    expect(res.statusCode).toBe(201);
  });

  it('re-closing rewrites the totals rather than adding a second row', async () => {
    const again = await t.app.inject({ method: 'POST', url: `/api/accounting/periods/${thisPeriod()}/close`, headers: { cookie } });
    expect(again.statusCode).toBe(200);
    expect(again.json().entryCount).toBe(2);
    expect(again.json().debitTotalMinor).toBe(136000);
    const list = await t.app.inject({ method: 'GET', url: '/api/accounting/periods', headers: { cookie } });
    expect(list.json().rows).toHaveLength(1);
  });

  it('audits both the close and the reopen', async () => {
    const del = await t.app.inject({ method: 'DELETE', url: `/api/accounting/periods/${thisPeriod()}`, headers: { cookie } });
    expect(del.statusCode).toBe(204);
    const list = await t.app.inject({ method: 'GET', url: '/api/accounting/periods', headers: { cookie } });
    expect(list.json().rows).toEqual([]);
    const rows = await t.db.query.auditLogs.findMany({});
    expect(rows.filter((r) => r.action === 'accounting.period_close')).toHaveLength(2);
    expect(rows.filter((r) => r.action === 'accounting.period_reopen')).toHaveLength(1);
  });

  it('reopening a period that was never closed is a 404', async () => {
    const res = await t.app.inject({ method: 'DELETE', url: '/api/accounting/periods/2019-01', headers: { cookie } });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a malformed period', async () => {
    expect((await t.app.inject({ method: 'POST', url: '/api/accounting/periods/2026-13/close', headers: { cookie } })).statusCode).toBe(400);
  });
});
