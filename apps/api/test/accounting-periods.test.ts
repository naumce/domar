import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaffUser, registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

let t: Awaited<ReturnType<typeof createTestApp>>;
let cookie: string;
let readonlyCookie: string;
let buildingId: string;
let invoiceId: string;

// A month that has already ended by any real run of this suite (today is 2026-09-25 or later),
// so `closeAccountingPeriod`'s "has this period ended" guard (fix round 1, item 1) never refuses it —
// unlike `thisPeriod()`, which the guard now refuses to close for exactly that reason (tested below).
const CLOSED_PERIOD = '2026-08';
const thisPeriod = () => new Date().toISOString().slice(0, 7);

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
  await post(`/api/buildings/${buildingId}/periods/${period.id}/generate`);
  await post(`/api/buildings/${buildingId}/periods/${period.id}/publish`);
  const invoices = (await t.app.inject({ method: 'GET', url: `/api/invoices?buildingId=${buildingId}`, headers: { cookie } })).json();
  invoiceId = invoices.rows[0].id;
  const slots: [string, string, string][] = [
    ['owner_receivable', '1200', 'Побарувања'], ['revenue_service', '7400', 'Приходи од услуги'],
    ['revenue_management_fee', '7410', 'Приходи од управување'], ['revenue_reserve_fund', '7420', 'Резервен фонд'],
    ['vat_output', '4700', 'ДДВ на излез'], ['cash_regular', '1000', 'Редовна сметка'],
    ['cash_reserve', '1001', 'Резервна сметка'], ['expense_default', '4000', 'Трошоци'], ['opening_balance', '9000', 'Почетна состојба'],
  ];
  for (const [slot, code, name] of slots) {
    await t.app.inject({ method: 'PUT', url: `/api/account-codes/${slot}`, headers: { cookie }, payload: { code, name } });
  }
  // One payment dated inside the already-ended CLOSED_PERIOD, so closing it has something real to
  // total (the invoice itself was published — and so booked — just now, in whatever month this suite
  // actually runs in, which is irrelevant to the assertions below; only the payment's own `paidAt`
  // decides which accounting period it belongs to, same trick `accounting-preview.test.ts` uses).
  await t.app.inject({
    method: 'POST', url: `/api/invoices/${invoiceId}/payments`, headers: { cookie },
    payload: { amountMinor: 20000, method: 'cash', paidAt: '2026-08-10T10:00:00.000Z' },
  });
});
afterAll(async () => { await t.close(); });

describe('closing a period', () => {
  it('refuses a period that has not ended yet', async () => {
    const res = await t.app.inject({ method: 'POST', url: `/api/accounting/periods/${thisPeriod()}/close`, headers: { cookie } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('period_not_ended');
  });

  it('is refused to a readonly user', async () => {
    const res = await t.app.inject({ method: 'POST', url: `/api/accounting/periods/${CLOSED_PERIOD}/close`, headers: { cookie: readonlyCookie } });
    expect(res.statusCode).toBe(403);
  });

  // The read gate on the list is the documents one, which keeps `readonly` (spec §7) and drops only
  // the technician — the role the Accounting page is already hidden from.
  it('but the list itself is readable by a readonly user', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/accounting/periods', headers: { cookie: readonlyCookie } });
    expect(res.statusCode).toBe(200);
  });

  it('records the totals, who closed it and when', async () => {
    const res = await t.app.inject({ method: 'POST', url: `/api/accounting/periods/${CLOSED_PERIOD}/close`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const row = res.json();
    expect(row.period).toBe(CLOSED_PERIOD);
    expect(row.debitTotalMinor).toBe(row.creditTotalMinor);
    expect(row.debitTotalMinor).toBe(20000);
    expect(row.entryCount).toBe(1);
    expect(row.closedAt).toBeTruthy();
    expect(row.closedByName).toBe('O acct-periods');
  });

  it('adds no refusal anywhere else: a payment into the closed period still records', async () => {
    const res = await t.app.inject({
      method: 'POST', url: `/api/invoices/${invoiceId}/payments`, headers: { cookie },
      payload: { amountMinor: 5000, method: 'cash', paidAt: '2026-08-20T10:00:00.000Z' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('reports a posting booked into the closed period, but created after it closed, as a prior-period adjustment — not blended into the totals unflagged', async () => {
    // Task 4's original rule (booked before the window, created inside it) never catches this shape:
    // the late payment above is booked *inside* CLOSED_PERIOD's own month, same as the one that was
    // already there when it closed — the only difference is when it arrived (fix round 1, item 1).
    const res = await t.app.inject({ method: 'GET', url: `/api/accounting/preview?from=${CLOSED_PERIOD}-01&to=2026-09-01`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totals.entryCount).toBe(2);
    expect(body.totals.debitMinor).toBe(body.totals.creditMinor);
    expect(body.totals.debitMinor).toBe(25000);
    expect(body.adjustmentCount).toBe(1);
  });

  it('re-closing rewrites the totals rather than adding a second row', async () => {
    const again = await t.app.inject({ method: 'POST', url: `/api/accounting/periods/${CLOSED_PERIOD}/close`, headers: { cookie } });
    expect(again.statusCode).toBe(200);
    expect(again.json().entryCount).toBe(2);
    expect(again.json().debitTotalMinor).toBe(25000);
    const list = await t.app.inject({ method: 'GET', url: '/api/accounting/periods', headers: { cookie } });
    expect(list.json().rows).toHaveLength(1);
  });

  it('audits both the close and the reopen', async () => {
    const del = await t.app.inject({ method: 'DELETE', url: `/api/accounting/periods/${CLOSED_PERIOD}`, headers: { cookie } });
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
