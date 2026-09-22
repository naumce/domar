import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupPublishedBuilding } from './billing-fixture.js';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

describe('payments', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>; let a: Awaited<ReturnType<typeof registerTenant>>; let fx: Awaited<ReturnType<typeof setupPublishedBuilding>>;
  const h = () => ({ cookie: a.cookie });
  beforeAll(async () => { t = await createTestApp(); a = await registerTenant(t.app, 'firma-a'); fx = await setupPublishedBuilding(t.app, a.cookie); });
  afterAll(async () => { await t.close(); });
  const post = (url: string, payload: Record<string, unknown>) => t.app.inject({ method: 'POST', url, headers: h(), payload });
  const balances = async () => {
    const p = await t.db.query.postings.findMany();
    const sum = (f: (x: typeof p[number]) => boolean) => p.filter(f).reduce((s, x) => s + x.amountMinor, 0);
    return { ownerO1: sum((x) => x.account === 'owner' && x.contactId === fx.owners.O1), regular: sum((x) => x.account === 'fund' && x.fund === 'regular'), reserve: sum((x) => x.account === 'fund' && x.fund === 'reserve') };
  };

  it('records a partial payment, allocates across funds and marks the invoice partially paid', async () => {
    const before = await balances();
    expect(before.ownerO1).toBe(256099);
    const res = await post(`/api/invoices/${fx.invoices.O1.id}/payments`, { amountMinor: 100000, method: 'bank_transfer', paidAt: '2026-10-05T09:00:00.000Z', reference: 'INV-0001/2026' });
    expect(res.statusCode).toBe(201);
    expect(res.json().payment).toMatchObject({ amountMinor: 100000, method: 'bank_transfer', status: 'completed', invoiceId: fx.invoices.O1.id, contactId: fx.owners.O1 });
    expect(res.json().invoice).toEqual({ id: fx.invoices.O1.id, status: 'partially_paid', paidMinor: 100000, outstandingMinor: 156099 });
    const after = await balances();
    expect(after.ownerO1).toBe(156099);
    expect(after.regular - before.regular).toBe(80476);
    expect(after.reserve - before.reserve).toBe(19524);
  });

  it('completes the invoice on full payment and allows overpayment as owner credit', async () => {
    const res = await post(`/api/invoices/${fx.invoices.O1.id}/payments`, { amountMinor: 160000, method: 'cash', paidAt: '2026-10-06T09:00:00.000Z' });
    expect(res.json().invoice).toMatchObject({ status: 'paid', paidMinor: 260000, outstandingMinor: 0 });
    expect((await balances()).ownerO1).toBe(-3901);
    const detail = (await t.app.inject({ method: 'GET', url: `/api/invoices/${fx.invoices.O1.id}`, headers: h() })).json();
    expect(detail.payments).toHaveLength(2);
    expect(detail.paidMinor).toBe(260000);
  });

  it('voids a payment with reversing postings and recomputes the status; refuses to void twice', async () => {
    const list = (await t.app.inject({ method: 'GET', url: `/api/invoices/${fx.invoices.O1.id}/payments`, headers: h() })).json().rows;
    const cash = list.find((p: { method: string }) => p.method === 'cash');
    const res = await post(`/api/payments/${cash.id}/void`, { reason: 'погрешен износ' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ payment: { status: 'voided', voidReason: 'погрешен износ' }, invoice: { status: 'partially_paid', paidMinor: 100000 } });
    expect((await balances()).ownerO1).toBe(156099);
    const voidPostings = (await t.db.query.postings.findMany()).filter((p) => p.refType === 'payment_void' && p.refId === cash.id);
    expect(voidPostings.length).toBeGreaterThanOrEqual(2);
    expect((await post(`/api/payments/${cash.id}/void`, { reason: 'x' })).statusCode).toBe(409);
  });

  it('rejects payments on drafts, bad amounts and foreign invoices; records on-account payments', async () => {
    expect((await post(`/api/invoices/${fx.invoices.O2.id}/payments`, { amountMinor: 0, method: 'cash', paidAt: '2026-10-06T09:00:00.000Z' })).statusCode).toBe(400);
    const period = (await post(`/api/buildings/${fx.buildingId}/periods`, { period: '2027-03' })).json();
    await post(`/api/buildings/${fx.buildingId}/periods/${period.id}/generate`, {});
    const draft = (await t.app.inject({ method: 'GET', url: `/api/invoices?buildingId=${fx.buildingId}&period=2027-03`, headers: h() })).json().rows[0];
    const onDraft = await post(`/api/invoices/${draft.id}/payments`, { amountMinor: 100, method: 'cash', paidAt: '2026-10-06T09:00:00.000Z' });
    expect(onDraft.statusCode).toBe(409);
    expect(onDraft.json().error.code).toBe('invoice_not_payable');
    expect((await t.app.inject({ method: 'GET', url: `/api/invoices/${draft.id}/payments`, headers: { cookie: (await registerTenant(t.app, 'firma-c')).cookie } })).statusCode).toBe(404);
    const b = await registerTenant(t.app, 'firma-b');
    expect((await t.app.inject({ method: 'POST', url: `/api/invoices/${fx.invoices.O2.id}/payments`, headers: { cookie: b.cookie }, payload: { amountMinor: 100, method: 'cash', paidAt: '2026-10-06T09:00:00.000Z' } })).statusCode).toBe(404);
    const onAccount = await post(`/api/buildings/${fx.buildingId}/payments`, { contactId: fx.owners.O3, amountMinor: 5000, method: 'cash', paidAt: '2026-10-07T09:00:00.000Z', note: 'аконтација' });
    expect(onAccount.statusCode).toBe(201);
    expect(onAccount.json().payment.invoiceId).toBeNull();
    expect(onAccount.json().invoice).toBeNull();
  });

  it('lists payments with filters and a summary', async () => {
    const all = (await t.app.inject({ method: 'GET', url: `/api/payments?buildingId=${fx.buildingId}`, headers: h() })).json();
    expect(all.total).toBe(3);
    expect(all.summary).toMatchObject({ completedCount: 2, voidedCount: 1, totalMinor: 105000 });
    expect(all.summary.byMethod.find((m: { method: string }) => m.method === 'bank_transfer').totalMinor).toBe(100000);
    const search = (await t.app.inject({ method: 'GET', url: `/api/payments?search=INV-0001`, headers: h() })).json();
    expect(search.rows.map((r: { amountMinor: number }) => r.amountMinor)).toEqual([160000, 100000]);
    const range = (await t.app.inject({ method: 'GET', url: `/api/payments?from=2026-10-07T00:00:00.000Z&to=2026-10-08T00:00:00.000Z`, headers: h() })).json();
    expect(range.rows).toHaveLength(1);
    expect(range.rows[0].contact.lastName).toBe('Велковски');
  });

  it('serialises concurrent voids of the same payment', async () => {
    const p = (await post(`/api/invoices/${fx.invoices.O2.id}/payments`, { amountMinor: 1000, method: 'cash', paidAt: '2026-10-08T09:00:00.000Z' })).json().payment;
    const [r1, r2] = await Promise.all([post(`/api/payments/${p.id}/void`, { reason: 'a' }), post(`/api/payments/${p.id}/void`, { reason: 'b' })]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 409]);
    const all = await t.db.query.postings.findMany();
    const originals = all.filter((x) => x.refType === 'payment' && x.refId === p.id);
    const voids = all.filter((x) => x.refType === 'payment_void' && x.refId === p.id);
    expect(originals.length).toBeGreaterThan(0);
    expect(voids).toHaveLength(originals.length); // reversed exactly once, not twice
  });
});
