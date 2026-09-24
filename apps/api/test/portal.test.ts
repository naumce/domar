import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Chromium is mocked exactly as in reminders.test.ts: the portal PDF route must be exercised and no
// test may depend on a browser being installed.
vi.mock('playwright-core', () => {
  const launch = vi.fn(async () => ({
    isConnected: () => true,
    newContext: async () => ({ newPage: async () => ({ setContent: async () => {}, pdf: async () => Buffer.from('%PDF-portal') }), close: async () => {} }),
    close: async () => {},
  }));
  return { chromium: { launch } };
});

import { setupPublishedBuilding } from './billing-fixture.js';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

describe('portal data', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let b: Awaited<ReturnType<typeof registerTenant>>;
  let A: Awaited<ReturnType<typeof setupPublishedBuilding>>;
  let B: Awaited<ReturnType<typeof setupPublishedBuilding>>;
  let ownerCookie = '';
  let strangerCookie = '';

  const staffPost = (url: string, payload: Record<string, unknown> = {}, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? a.cookie }, payload });
  const portalGet = (url: string, cookie?: string) => t.app.inject({ method: 'GET', url, headers: { cookie: cookie ?? ownerCookie } });
  const registerOwner = async (contactId: string, email: string, staffCookie: string) => {
    const code = (await staffPost(`/api/contacts/${contactId}/portal-invite`, {}, staffCookie)).json().code;
    const res = await t.app.inject({ method: 'POST', url: '/api/portal/register', payload: { code, email, password: 'correct-horse-1' } });
    expect(res.statusCode).toBe(201);
    return String(res.headers['set-cookie']).split(';')[0]!;
  };

  beforeAll(async () => {
    t = await createTestApp({ SMTP_URL: 'json' });
    a = await registerTenant(t.app, 'firma-po');
    b = await registerTenant(t.app, 'firma-po2');
    A = await setupPublishedBuilding(t.app, a.cookie);
    B = await setupPublishedBuilding(t.app, b.cookie);

    // O1 pays the whole invoice: the fund split is then exact (regular 206099 + reserve 50000).
    await staffPost(`/api/invoices/${A.invoices.O1.id}/payments`, { amountMinor: 256099, method: 'bank_transfer', paidAt: daysAgo(3) });
    // One recent expense and one two years old: the fund list is a 12-month window, the balance is not.
    await staffPost(`/api/buildings/${A.buildingId}/reserve-fund/expenses`, { fund: 'regular', description: 'Поправка на лифт', amountMinor: 120000, paidAt: daysAgo(10) });
    await staffPost(`/api/buildings/${A.buildingId}/reserve-fund/expenses`, { fund: 'regular', description: 'Стар трошок', amountMinor: 5000, paidAt: daysAgo(730) });

    ownerCookie = await registerOwner(A.owners.O1, 'o1@owner.mk', a.cookie);
    strangerCookie = await registerOwner(B.owners.O1, 'b1@owner.mk', b.cookie);
  });
  afterAll(async () => {
    const m = await import('../src/pdf/html-to-pdf.js');
    await m.closePdfBrowser();
    m._resetForTests();
    await t.close();
  });

  it('lists only the linked contact’s published invoices', async () => {
    const res = await portalGet(`/api/portal/invoices?contactId=${A.owners.O1}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      id: A.invoices.O1.id, number: A.invoices.O1.number, status: 'paid', period: '2026-09',
      totalMinor: 256099, paidMinor: 256099, outstandingMinor: 0, previousBalanceMinor: 0, amountDueMinor: 256099,
    });
    expect(body.rows[0].contact.id).toBe(A.owners.O1);
    expect(JSON.stringify(body)).not.toContain('Бошковски'); // O2 is nowhere in the payload
  });

  it('returns one invoice with its lines and the owner’s own payments', async () => {
    const res = await portalGet(`/api/portal/invoices/${A.invoices.O1.id}?contactId=${A.owners.O1}`);
    expect(res.statusCode).toBe(200);
    const inv = res.json();
    expect(inv.lines.length).toBeGreaterThan(0);
    expect(inv.lines.some((l: { kind: string }) => l.kind === 'reserve_fund')).toBe(true);
    expect(inv.payments).toHaveLength(1);
    expect(inv.payments[0].amountMinor).toBe(256099);
    expect(inv.reserveFundBuildingBalanceMinor).toBe(3500000);
    expect(inv.building.name).toBe('Партизанска 12');
  });

  it('renders the invoice PDF with the manager’s renderer', async () => {
    const res = await portalGet(`/api/portal/invoices/${A.invoices.O1.id}/pdf?contactId=${A.owners.O1}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain(A.invoices.O1.number.replace(/[^A-Za-z0-9_.-]/g, '_'));
    expect(res.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('lists the owner’s payments', async () => {
    const res = await portalGet(`/api/portal/payments?contactId=${A.owners.O1}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
    expect(res.json().rows[0]).toMatchObject({ amountMinor: 256099, method: 'bank_transfer', status: 'completed' });
    expect(res.json().rows[0].contact.id).toBe(A.owners.O1);
  });

  it('returns the owner statement with a running balance that nets to zero', async () => {
    const res = await portalGet(`/api/portal/statement?contactId=${A.owners.O1}`);
    expect(res.statusCode).toBe(200);
    const st = res.json();
    expect(st.contact.id).toBe(A.owners.O1);
    expect(st.balanceMinor).toBe(0);
    expect(st.rows.reduce((s: number, r: { amountMinor: number }) => s + r.amountMinor, 0)).toBe(0);
    expect(st.rows.some((r: { kind: string }) => r.kind === 'charge')).toBe(true);
    expect(st.rows.some((r: { kind: string }) => r.kind === 'payment')).toBe(true);
  });

  it('shows both building funds with 12 months of transactions and no owner names', async () => {
    const res = await portalGet(`/api/portal/buildings/${A.buildingId}/fund?contactId=${A.owners.O1}`);
    expect(res.statusCode).toBe(200);
    const f = res.json();
    expect(f.building).toEqual({ id: A.buildingId, name: 'Партизанска 12' });
    // reserve: 3.500.000 opening + 50.000 of O1's payment. regular: 206.099 of that payment − 120.000 − 5.000.
    expect(f.reserve.balanceMinor).toBe(3550000);
    expect(f.regular.balanceMinor).toBe(81099);
    // billed = Σ owner charge postings: reserve 225 m² × 1000; regular 1.064.532 total − 225.000 reserve.
    expect(f.reserve.billedMinor).toBe(225000);
    expect(f.regular.billedMinor).toBe(839532);

    expect(f.transactions).toHaveLength(4); // the two-year-old expense is outside the window
    const byKind = (k: string) => f.transactions.filter((x: { kind: string }) => x.kind === k);
    expect(byKind('opening')).toHaveLength(1);
    expect(byKind('opening')[0]).toMatchObject({ fund: 'reserve', amountMinor: 3500000, description: null });
    expect(byKind('payment').map((x: { amountMinor: number }) => x.amountMinor).sort((x: number, y: number) => x - y)).toEqual([50000, 206099]);
    expect(byKind('expense')).toHaveLength(1);
    expect(byKind('expense')[0]).toMatchObject({ fund: 'regular', amountMinor: -120000, description: 'Поправка на лифт' });
    expect(byKind('charge')).toHaveLength(0); // owner charges are per-owner rows and stay private
    expect(JSON.stringify(f)).not.toContain('Анѓеловски');
    expect(JSON.stringify(f)).not.toContain('Бошковски');
  });

  it('404s every route for a contact the account is not linked to', async () => {
    const other = A.owners.O2;
    for (const url of [
      `/api/portal/invoices?contactId=${other}`,
      `/api/portal/invoices/${A.invoices.O2.id}?contactId=${other}`,
      `/api/portal/invoices/${A.invoices.O2.id}/pdf?contactId=${other}`,
      `/api/portal/payments?contactId=${other}`,
      `/api/portal/statement?contactId=${other}`,
      `/api/portal/buildings/${A.buildingId}/fund?contactId=${other}`,
    ]) {
      const res = await portalGet(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    }
  });

  it('404s when a linked contact id is paired with another contact’s invoice', async () => {
    const res = await portalGet(`/api/portal/invoices/${A.invoices.O2.id}?contactId=${A.owners.O1}`);
    expect(res.statusCode).toBe(404);
  });

  it('404s across tenants even for an owner who is linked somewhere else', async () => {
    // The B owner is signed in; A's ids belong to a tenant they have no link in.
    for (const url of [
      `/api/portal/invoices?contactId=${A.owners.O1}`,
      `/api/portal/buildings/${A.buildingId}/fund?contactId=${B.owners.O1}`,
    ]) {
      expect((await portalGet(url, strangerCookie)).statusCode, url).toBe(404);
    }
  });

  it('404s for a building the linked contact owns nothing in', async () => {
    const empty = (await staffPost('/api/buildings', { name: 'Друга зграда' })).json().id;
    expect((await portalGet(`/api/portal/buildings/${empty}/fund?contactId=${A.owners.O1}`)).statusCode).toBe(404);
  });

  it('hides drafts', async () => {
    const p = (await staffPost(`/api/buildings/${A.buildingId}/periods`, { period: '2026-10' })).json().id;
    await staffPost(`/api/buildings/${A.buildingId}/periods/${p}/generate`, {});
    const list = (await portalGet(`/api/portal/invoices?contactId=${A.owners.O1}`)).json();
    expect(list.total).toBe(1);
    const drafts = (await t.app.inject({ method: 'GET', url: `/api/invoices?buildingId=${A.buildingId}&period=2026-10`, headers: { cookie: a.cookie } })).json().rows;
    const draftOfO1 = drafts.find((r: { contactId: string }) => r.contactId === A.owners.O1);
    expect((await portalGet(`/api/portal/invoices/${draftOfO1.id}?contactId=${A.owners.O1}`)).statusCode).toBe(404);
  });

  it('requires an owner session', async () => {
    expect((await t.app.inject({ method: 'GET', url: `/api/portal/invoices?contactId=${A.owners.O1}` })).statusCode).toBe(401);
    expect((await portalGet(`/api/portal/invoices?contactId=${A.owners.O1}`, a.cookie)).statusCode).toBe(401);
  });

  it('rejects a missing or malformed contactId', async () => {
    expect((await portalGet('/api/portal/invoices')).statusCode).toBe(400);
    expect((await portalGet('/api/portal/statement?contactId=not-a-uuid')).statusCode).toBe(400);
  });
});
