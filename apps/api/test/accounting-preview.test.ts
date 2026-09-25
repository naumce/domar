import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

let t: Awaited<ReturnType<typeof createTestApp>>;
let cookie: string;
let buildingId: string;
let invoiceId: string;

/** A building with one owner, one 18 % service, one published September invoice and one payment. */
beforeAll(async () => {
  t = await createTestApp();
  cookie = (await registerTenant(t.app, 'acct-preview')).cookie;
  const post = async (url: string, payload: object = {}) => {
    const res = await t.app.inject({ method: 'POST', url, headers: { cookie }, payload });
    if (res.statusCode >= 300) throw new Error(`${url} → ${res.body}`);
    return res.json();
  };
  const rates = (await t.app.inject({ method: 'GET', url: '/api/tax-rates', headers: { cookie } })).json();
  const vatId = rates.rows.find((r: { rateBp: number }) => r.rateBp === 1800).id;
  const owner = await post('/api/contacts', { firstName: 'Марко', lastName: 'Марков' });
  const building = await post('/api/buildings', { name: 'Партизанска 1', address: 'Партизанска 1', city: 'Скопје', postalCode: '1000' });
  buildingId = building.id;
  await post(`/api/buildings/${buildingId}/units`, { label: '1', kind: 'apartment', areaM2: 50, ownerContactId: owner.id });
  const service = await post('/api/services', { name: 'Чистење', pricing: 'fixed_per_unit', defaultPriceMinor: 100000, taxRateId: vatId, appliesTo: ['apartment'] });
  await post(`/api/buildings/${buildingId}/services`, { serviceId: service.id, startsPeriod: '2026-01' });
  const period = await post(`/api/buildings/${buildingId}/periods`, { period: '2026-09' });
  await post(`/api/buildings/${buildingId}/periods/${period.id}/generate`);
  await post(`/api/buildings/${buildingId}/periods/${period.id}/publish`);
  const invoices = (await t.app.inject({ method: 'GET', url: `/api/invoices?buildingId=${buildingId}`, headers: { cookie } })).json();
  invoiceId = invoices.rows[0].id;
  // Pinned inside the 2026-09 window every assertion below targets, not "now": the invoice's own
  // charge posting is booked when the period is published (above, at real test-run time) and this
  // fixture only controls the payment's date, so pinning it is what keeps the trial-balance and
  // entry-count assertions from drifting with the calendar.
  await post(`/api/invoices/${invoiceId}/payments`, { amountMinor: 118000, method: 'bank_transfer', paidAt: '2026-09-15T10:00:00.000Z' });
});
afterAll(async () => { await t.close(); });

const mapChart = async () => {
  const slots: [string, string, string][] = [
    ['owner_receivable', '1200', 'Побарувања'], ['revenue_service', '7400', 'Приходи од услуги'],
    ['revenue_management_fee', '7410', 'Приходи од управување'], ['revenue_reserve_fund', '7420', 'Резервен фонд'],
    ['vat_output', '4700', 'ДДВ на излез'], ['cash_regular', '1000', 'Редовна сметка'],
    ['cash_reserve', '1001', 'Резервна сметка'], ['expense_default', '4000', 'Трошоци'], ['opening_balance', '9000', 'Почетна состојба'],
  ];
  for (const [slot, code, name] of slots) {
    await t.app.inject({ method: 'PUT', url: `/api/account-codes/${slot}`, headers: { cookie }, payload: { code, name } });
  }
};

describe('GET /api/accounting/preview', () => {
  it('refuses while the chart is incomplete and names every missing slot', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/accounting/preview?from=2026-09-01&to=2026-10-01', headers: { cookie } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('chart_incomplete');
    expect(res.json().error.details.missing.map((m: { slot: string }) => m.slot)).toContain('owner_receivable');
  });

  it('returns a trial balance that balances once the chart is complete', async () => {
    await mapChart();
    const res = await t.app.inject({ method: 'GET', url: '/api/accounting/preview?from=2026-09-01&to=2026-10-01', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totals.debitMinor).toBe(body.totals.creditMinor);
    expect(body.totals.entryCount).toBe(2);
    const byCode = Object.fromEntries(body.trialBalance.map((r: { code: string; debitMinor: number; creditMinor: number }) => [r.code, r]));
    expect(byCode['1200']).toMatchObject({ debitMinor: 118000, creditMinor: 118000 });
    expect(byCode['7400']).toMatchObject({ debitMinor: 0, creditMinor: 100000 });
    expect(byCode['4700']).toMatchObject({ debitMinor: 0, creditMinor: 18000 });
    expect(byCode['1000']).toMatchObject({ debitMinor: 118000, creditMinor: 0 });
  });

  it('scopes to one building when asked', async () => {
    const other = await t.app.inject({
      method: 'POST', url: '/api/buildings', headers: { cookie },
      payload: { name: 'Празна', address: 'Празна 2', city: 'Скопје', postalCode: '1000' },
    });
    const res = await t.app.inject({ method: 'GET', url: `/api/accounting/preview?from=2026-09-01&to=2026-10-01&buildingId=${other.json().id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().totals).toEqual({ debitMinor: 0, creditMinor: 0, entryCount: 0, lineCount: 0 });
  });

  it('404s on a building of another tenant, never 403', async () => {
    const other = await registerTenant(t.app, 'acct-preview-2');
    const theirs = await t.app.inject({
      method: 'POST', url: '/api/buildings', headers: { cookie: other.cookie },
      payload: { name: 'Туѓа', address: 'Туѓа 3', city: 'Скопје', postalCode: '1000' },
    });
    const res = await t.app.inject({ method: 'GET', url: `/api/accounting/preview?from=2026-09-01&to=2026-10-01&buildingId=${theirs.json().id}`, headers: { cookie } });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a window that ends before it starts', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/accounting/preview?from=2026-10-01&to=2026-09-01', headers: { cookie } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_window');
  });

  it('reports a payment that arrived after its month as a prior-period adjustment', async () => {
    // Built in the tenant's own zone (the default, Europe/Skopje), the same way the production
    // window is resolved (civilDayStart) — a UTC calendar date can name the wrong civil day and
    // exclude the instant it was meant to bracket for a couple of hours around UTC midnight.
    const skopjeDay = (x: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Skopje', year: 'numeric', month: '2-digit', day: '2-digit' }).format(x);
    const from = skopjeDay(new Date(Date.now() - 60_000));
    const to = skopjeDay(new Date(Date.now() + 86_400_000));
    // This "now"-centred window also reaches the 2026-09-15 payment pinned in `beforeAll` (its
    // `bookedAt` is before `from` and its `createdAt`, set at insert time, is inside this window
    // too) — so the baseline is measured, not assumed, and the assertion below is about what this
    // test's own payment adds, not the tenant's total adjustment count.
    const before = (await t.app.inject({ method: 'GET', url: `/api/accounting/preview?from=${from}&to=${to}`, headers: { cookie } })).json();
    // Booked in August (`paidAt`), created now: it belongs to August and arrives in this window.
    await t.app.inject({
      method: 'POST', url: `/api/invoices/${invoiceId}/payments`, headers: { cookie },
      payload: { amountMinor: 1000, method: 'cash', paidAt: '2026-08-15T10:00:00.000Z' },
    });
    const res = await t.app.inject({ method: 'GET', url: `/api/accounting/preview?from=${from}&to=${to}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().adjustmentCount).toBe(before.adjustmentCount + 1);
  });
});
