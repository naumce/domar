import { schema } from '@domar/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password.js';
import { setupPublishedBuilding } from './billing-fixture.js';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

describe('bank statements', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>; let a: Awaited<ReturnType<typeof registerTenant>>; let fx: Awaited<ReturnType<typeof setupPublishedBuilding>>; let readonlyCookie: string;
  const h = () => ({ cookie: a.cookie });
  beforeAll(async () => {
    t = await createTestApp(); a = await registerTenant(t.app, 'firma-a'); fx = await setupPublishedBuilding(t.app, a.cookie);
    await t.db.insert(schema.users).values({ tenantId: a.tenantId, email: 'ro@firma-a.mk', passwordHash: await hashPassword('correct-horse-1'), firstName: 'R', lastName: 'O', role: 'readonly' });
    const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantSlug: 'firma-a', email: 'ro@firma-a.mk', password: 'correct-horse-1' } });
    readonlyCookie = String(login.headers['set-cookie']).split(';')[0]!;
  });
  afterAll(async () => { await t.close(); });
  const post = (url: string, payload: Record<string, unknown>) => t.app.inject({ method: 'POST', url, headers: h(), payload });
  const csv = (rows: string[]) => ['date;amount;reference;counterparty', ...rows].join('\n');
  /** Statements are listed newest first; the first import is the one carrying lines. */
  const firstImport = async () => {
    const rows = (await t.app.inject({ method: 'GET', url: `/api/buildings/${fx.buildingId}/statements`, headers: h() })).json().rows;
    return rows[rows.length - 1] as { id: string };
  };

  it('imports a CSV, auto-confirms exact matches and suggests likely ones', async () => {
    const content = csv([
      `2026-10-05;2.560,99;Uplata ${fx.invoices.O1.number} stan 1;Marko`,           // exact → auto payment (O1 total 256099)
      `2026-10-05;3.540,57;uplata za septemvri;Boskovski`,                          // likely (amount + surname of O2)
      `2026-10-06;100,00;nepoznato;Nekoj`,                                            // unmatched
      `2026-10-06;-12,00;provizija;Banka`,                                             // debit, ignored by matching
    ]);
    const res = await post(`/api/buildings/${fx.buildingId}/statements`, { filename: 'izvod.csv', content });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ format: 'csv', lineCount: 4, matchedCount: 1, skippedCount: 0 });
    const lines = res.json().lines as { lineNo: number; matchStatus: string; confidence: string | null; suggestedInvoice: { id: string } | null; payment: { amountMinor: number } | null }[];
    expect(lines.map((l) => [l.lineNo, l.matchStatus, l.confidence])).toEqual([[1, 'matched', 'exact'], [2, 'suggested', 'likely'], [3, 'unmatched', null], [4, 'unmatched', null]]);
    expect(lines[0]!.payment).toMatchObject({ amountMinor: 256099 });
    expect(lines[1]!.suggestedInvoice?.id).toBe(fx.invoices.O2.id);
    const o1 = (await t.app.inject({ method: 'GET', url: `/api/invoices/${fx.invoices.O1.id}`, headers: h() })).json();
    expect(o1).toMatchObject({ status: 'paid', paidMinor: 256099 });
    expect(o1.payments[0]).toMatchObject({ method: 'bank_transfer', reference: expect.stringContaining(fx.invoices.O1.number) });
  });

  it('re-importing the same file skips duplicates', async () => {
    const content = csv([`2026-10-05;2.560,99;Uplata ${fx.invoices.O1.number} stan 1;Marko`]);
    const res = await post(`/api/buildings/${fx.buildingId}/statements`, { filename: 'izvod.csv', content });
    expect(res.json()).toMatchObject({ lineCount: 0, skippedCount: 1 });
  });

  it('confirms a suggested line, ignores another, and unmatch reverses the payment', async () => {
    const detail = (await t.app.inject({ method: 'GET', url: `/api/statements/${(await firstImport()).id}`, headers: h() })).json();
    const likely = detail.lines.find((l: { confidence: string | null }) => l.confidence === 'likely');
    const unmatched = detail.lines.find((l: { matchStatus: string; amountMinor: number }) => l.matchStatus === 'unmatched' && l.amountMinor > 0);
    const confirmed = await post(`/api/statement-lines/${likely.id}/confirm`, { invoiceId: fx.invoices.O2.id });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ matchStatus: 'matched', confidence: 'manual', payment: { amountMinor: 354057 } });
    expect((await t.app.inject({ method: 'GET', url: `/api/invoices/${fx.invoices.O2.id}`, headers: h() })).json().status).toBe('paid');
    expect((await post(`/api/statement-lines/${likely.id}/confirm`, { invoiceId: fx.invoices.O2.id })).statusCode).toBe(409);
    const ignored = await post(`/api/statement-lines/${unmatched.id}/ignore`, {});
    expect(ignored.json().matchStatus).toBe('ignored');
    const unmatch = await post(`/api/statement-lines/${likely.id}/unmatch`, {});
    expect(unmatch.json()).toMatchObject({ matchStatus: 'unmatched', payment: null });
    expect((await t.app.inject({ method: 'GET', url: `/api/invoices/${fx.invoices.O2.id}`, headers: h() })).json().status).toBe('published');
    const payments = (await t.app.inject({ method: 'GET', url: `/api/payments?invoiceId=${fx.invoices.O2.id}`, headers: h() })).json();
    expect(payments.rows[0]).toMatchObject({ status: 'voided', voidReason: 'unmatched' });
  });

  it('rejects debits, unknown formats, oversized files and foreign tenants', async () => {
    const statement = await firstImport();
    const detail = (await t.app.inject({ method: 'GET', url: `/api/statements/${statement.id}`, headers: h() })).json();
    const debit = detail.lines.find((l: { amountMinor: number }) => l.amountMinor < 0);
    expect((await post(`/api/statement-lines/${debit.id}/confirm`, { invoiceId: fx.invoices.O3.id })).json().error.code).toBe('not_a_credit');
    expect((await post(`/api/buildings/${fx.buildingId}/statements`, { filename: 'x.txt', content: 'hello world' })).json().error.code).toBe('unknown_format');
    expect((await post(`/api/buildings/${fx.buildingId}/statements`, { filename: 'x.csv', content: 'x'.repeat(2 * 1024 * 1024 + 1) })).json().error.code).toBe('too_large');
    const b = await registerTenant(t.app, 'firma-b');
    expect((await t.app.inject({ method: 'GET', url: `/api/statements/${statement.id}`, headers: { cookie: b.cookie } })).statusCode).toBe(404);
  });

  it('rejects an invoice from another building and writes by a readonly user', async () => {
    const otherBuildingId = (await post('/api/buildings', { name: 'Нова 1', shareBasis: 'area' })).json().id;
    const imported = (await post(`/api/buildings/${otherBuildingId}/statements`, { filename: 'druga.csv', content: csv(['2026-10-07;500,00;uplata;Petko']) })).json();
    const lineId = imported.lines[0].id;
    expect((await post(`/api/statement-lines/${lineId}/confirm`, { invoiceId: fx.invoices.O2.id })).json().error.code).toBe('invalid_reference');
    const forbidden = await t.app.inject({ method: 'POST', url: `/api/statement-lines/${lineId}/confirm`, headers: { cookie: readonlyCookie }, payload: { invoiceId: fx.invoices.O2.id } });
    expect(forbidden.statusCode).toBe(403);
  });

  it('imports MT940 too', async () => {
    const mt = [':20:S1', ':25:300000000123456', ':61:261010C4543,76NTRFNONREF//B1', `:86:?20${fx.invoices.O3.number}?32VELKOVSKI`, '-'].join('\r\n');
    const res = await post(`/api/buildings/${fx.buildingId}/statements`, { filename: 'izvod.sta', content: mt, autoConfirm: false });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ format: 'mt940', accountNumber: '300000000123456', lineCount: 1, matchedCount: 0 });
    expect(res.json().lines[0]).toMatchObject({ matchStatus: 'suggested', confidence: 'exact', suggestedInvoice: { id: fx.invoices.O3.id } });
  });

  it('imports the same file twice concurrently without duplicating lines or payments', async () => {
    const content = csv([
      `2026-11-01;1.000,00;Uplata ${fx.invoices.O2.number};Boskovski`,
      '2026-11-01;250,00;kirija;Nekoj',
    ]);
    const [one, two] = await Promise.all([
      post(`/api/buildings/${fx.buildingId}/statements`, { filename: 'nov.csv', content }),
      post(`/api/buildings/${fx.buildingId}/statements`, { filename: 'nov.csv', content }),
    ]);
    expect([one.statusCode, two.statusCode]).toEqual([201, 201]);
    expect(one.json().lineCount + two.json().lineCount).toBe(2);
    expect(one.json().skippedCount + two.json().skippedCount).toBe(2);
    const payments = (await t.app.inject({ method: 'GET', url: `/api/payments?invoiceId=${fx.invoices.O2.id}`, headers: h() })).json();
    expect(payments.rows.filter((p: { status: string; amountMinor: number }) => p.status === 'completed' && p.amountMinor === 100000)).toHaveLength(1);
  });
});
