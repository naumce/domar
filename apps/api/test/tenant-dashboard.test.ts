import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupPublishedBuilding } from './billing-fixture.js';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

describe('tenant settings, dashboard and owner statement', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>; let a: Awaited<ReturnType<typeof registerTenant>>; let fx: Awaited<ReturnType<typeof setupPublishedBuilding>>;
  const h = () => ({ cookie: a.cookie });
  beforeAll(async () => { t = await createTestApp(); a = await registerTenant(t.app, 'firma-a'); fx = await setupPublishedBuilding(t.app, a.cookie); });
  afterAll(async () => { await t.close(); });

  it('reads and updates organization settings, validating the timezone', async () => {
    const before = (await t.app.inject({ method: 'GET', url: '/api/tenant', headers: h() })).json();
    expect(before).toMatchObject({ slug: 'firma-a', timezone: 'Europe/Skopje', currency: 'MKD' });
    const upd = await t.app.inject({ method: 'PATCH', url: '/api/tenant', headers: h(), payload: { name: 'Фирма А ДООЕЛ', bankName: 'Комерцијална банка', bankAccount: '300000000000000', timezone: 'Europe/Belgrade' } });
    expect(upd.statusCode).toBe(200);
    expect(upd.json()).toMatchObject({ name: 'Фирма А ДООЕЛ', bankAccount: '300000000000000', timezone: 'Europe/Belgrade' });
    expect((await t.app.inject({ method: 'PATCH', url: '/api/tenant', headers: h(), payload: { timezone: 'Mars/Olympus' } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'PATCH', url: '/api/tenant', headers: h(), payload: { slug: 'other' } })).statusCode).toBe(400);
    const me = (await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: h() })).json();
    expect(me.tenant.timezone).toBe('Europe/Belgrade');
  });

  it('computes dashboard stats in the tenant month', async () => {
    await t.app.inject({ method: 'POST', url: `/api/invoices/${fx.invoices.O1.id}/payments`, headers: h(), payload: { amountMinor: 100000, method: 'cash', paidAt: new Date().toISOString() } });
    const s = (await t.app.inject({ method: 'GET', url: '/api/dashboard/stats', headers: h() })).json();
    expect(s).toMatchObject({ totalProperties: 1, totalUnits: 5, assignedOwners: 3, unpaidInvoices: 3, paidThisMonthMinor: 100000, complianceAttention: 1 });
    expect(s.billedThisMonthMinor).toBe(256099 + 354057 + 454376); // published now
    expect(s.outstandingMinor).toBe(256099 + 354057 + 454376 - 100000);
  });

  it('returns an owner statement with running balance', async () => {
    const st = (await t.app.inject({ method: 'GET', url: `/api/contacts/${fx.owners.O1}/statement?buildingId=${fx.buildingId}`, headers: h() })).json();
    expect(st.contact.lastName).toBe('Анѓеловски');
    expect(st.rows.length).toBeGreaterThanOrEqual(2);
    const last = st.rows[st.rows.length - 1];
    expect(last.balanceMinor).toBe(156099);
    expect(st.balanceMinor).toBe(156099);
    expect(st.rows[0]).toMatchObject({ refType: 'invoice', label: fx.invoices.O1.number });
    expect(last).toMatchObject({ refType: 'payment', kind: 'payment', amountMinor: expect.any(Number) });
    const b = await registerTenant(t.app, 'firma-b');
    expect((await t.app.inject({ method: 'GET', url: `/api/contacts/${fx.owners.O1}/statement`, headers: { cookie: b.cookie } })).statusCode).toBe(404);
  });
});
