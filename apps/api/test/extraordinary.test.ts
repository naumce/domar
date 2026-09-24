import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupPublishedBuilding } from './billing-fixture.js';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

const YEAR = new Date().getFullYear();
const num = (n: number) => `INV-${String(n).padStart(4, '0')}/${YEAR}`;

interface InvoiceRow { id: string; number: string; contactId: string; totalMinor: number; status: string; periodId: string; dueAt: string }

describe('extraordinary costs', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let b: Awaited<ReturnType<typeof registerTenant>>;
  let A: Awaited<ReturnType<typeof setupPublishedBuilding>>;
  let equalPeriodId = '';

  const post = (url: string, payload: Record<string, unknown> = {}, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? a.cookie }, payload });
  const get = (url: string, cookie?: string) => t.app.inject({ method: 'GET', url, headers: { cookie: cookie ?? a.cookie } });
  const invoicesOf = async (periodId: string): Promise<InvoiceRow[]> =>
    (await get(`/api/invoices?buildingId=${A.buildingId}&pageSize=200`)).json().rows.filter((r: InvoiceRow) => r.periodId === periodId);

  beforeAll(async () => {
    t = await createTestApp();
    a = await registerTenant(t.app, 'firma-extra');
    b = await registerTenant(t.app, 'firma-extra-other');
    A = await setupPublishedBuilding(t.app, a.cookie); // three invoices, INV-0001..0003
  });
  afterAll(async () => { await t.close(); });

  it('splits an equal distribution across the covered units and publishes the invoices', async () => {
    const res = await post(`/api/buildings/${A.buildingId}/extraordinary-costs`, {
      description: 'Санација на кров', amountMinor: 600000, fund: 'reserve',
      distribution: 'equal', appliesTo: ['apartment', 'commercial'], dueDays: 30,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    equalPeriodId = body.periodId;
    expect(body.invoiceCount).toBe(3);
    expect(body.totalMinor).toBe(600000);
    expect(body.period).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);

    const rows = await invoicesOf(equalPeriodId);
    const byOwner = Object.fromEntries(rows.map((r) => [r.contactId, r]));
    // 600.000 over units 1, 2 and L1 — three covered units, equal weights.
    expect(byOwner[A.owners.O1]!.totalMinor).toBe(200000);
    expect(byOwner[A.owners.O2]!.totalMinor).toBe(200000);
    expect(byOwner[A.owners.O3]!.totalMinor).toBe(200000);
    // Numbering continues the tenant's single sequence, by owner surname.
    expect(byOwner[A.owners.O1]!.number).toBe(num(4));
    expect(byOwner[A.owners.O2]!.number).toBe(num(5));
    expect(byOwner[A.owners.O3]!.number).toBe(num(6));
    expect(rows.every((r) => r.status === 'published')).toBe(true);
  });

  it('carries exactly one line per invoice: no reserve-fund contribution, no management fee', async () => {
    const rows = await invoicesOf(equalPeriodId);
    const detail = (await get(`/api/invoices/${rows[0]!.id}`)).json();
    expect(detail.lines).toHaveLength(1);
    expect(detail.lines[0].description).toBe('Санација на кров');
    expect(detail.lines[0].fund).toBe('reserve');
    expect(detail.lines[0].buildingWideNetMinor).toBe(600000);
    expect(detail.lines[0].taxRateBp).toBe(0);
    const period = (await get(`/api/buildings/${A.buildingId}/periods/${equalPeriodId}`)).json();
    expect(period.kind).toBe('extraordinary');
    expect(period.distributionBasis).toBe('equal');
    expect(period.managementFeeMinor).toBe(0);
    expect(period.lines).toHaveLength(1);
  });

  it('splits a share distribution by each unit ownership share', async () => {
    const units = (await get(`/api/buildings/${A.buildingId}/units`)).json().rows as { id: string; label: string }[];
    const shares: Record<string, number> = { '1': 0.2, '2': 0.3, L1: 0.5 };
    for (const u of units) {
      if (shares[u.label] === undefined) continue;
      const r = await t.app.inject({ method: 'PATCH', url: `/api/buildings/${A.buildingId}/units/${u.id}`, headers: { cookie: a.cookie }, payload: { ownershipShare: shares[u.label] } });
      expect(r.statusCode).toBe(200);
    }
    const res = await post(`/api/buildings/${A.buildingId}/extraordinary-costs`, {
      description: 'Замена на влезна врата', amountMinor: 1000000, fund: 'regular',
      distribution: 'share', appliesTo: ['apartment', 'commercial'], dueDays: 15,
    });
    expect(res.statusCode).toBe(201);
    const rows = await invoicesOf(res.json().periodId);
    const byOwner = Object.fromEntries(rows.map((r) => [r.contactId, r]));
    expect(byOwner[A.owners.O1]!.totalMinor).toBe(200000);
    expect(byOwner[A.owners.O2]!.totalMinor).toBe(300000);
    expect(byOwner[A.owners.O3]!.totalMinor).toBe(500000);
    expect(byOwner[A.owners.O1]!.number).toBe(num(7));
    expect(byOwner[A.owners.O3]!.number).toBe(num(9));
    const period = (await get(`/api/buildings/${A.buildingId}/periods/${res.json().periodId}`)).json();
    expect(period.distributionBasis).toBe('custom');
    // dueDays is honoured: 15 days from now, to the day.
    const days = Math.round((Date.parse(byOwner[A.owners.O1]!.dueAt) - Date.now()) / 86_400_000);
    expect(days).toBe(15);
  });

  it('writes extraordinary_cost_distributed with the invoice ids, and compliance counts it', async () => {
    const events = (await get(`/api/buildings/${A.buildingId}/legal-events?pageSize=100`)).json().rows
      .filter((e: { kind: string }) => e.kind === 'extraordinary_cost_distributed');
    expect(events).toHaveLength(2);
    const first = events.find((e: { evidence: { amountMinor: number } }) => e.evidence.amountMinor === 600000)!;
    expect(first.refType).toBe('billing_period');
    expect(first.refId).toBe(equalPeriodId);
    expect(first.evidence.fund).toBe('reserve');
    expect(first.evidence.distribution).toBe('equal');
    expect(first.evidence.invoiceCount).toBe(3);
    expect((first.evidence.invoiceIds as string[]).sort()).toEqual((await invoicesOf(equalPeriodId)).map((r) => r.id).sort());
    const duty = (await get(`/api/buildings/${A.buildingId}/compliance`)).json().duties.find((d: { key: string }) => d.key === 'extraordinary_costs');
    expect(duty.status).toBe('n/a');
    expect(duty.count).toBe(2);
  });

  it('leaves the resulting invoices payable like any other', async () => {
    const rows = await invoicesOf(equalPeriodId);
    const target = rows.find((r) => r.contactId === A.owners.O1)!;
    const res = await post(`/api/invoices/${target.id}/payments`, { amountMinor: 200000, method: 'bank_transfer', paidAt: new Date().toISOString() });
    expect(res.statusCode).toBe(201);
    expect(res.json().invoice.status).toBe('paid');
    expect(res.json().invoice.outstandingMinor).toBe(0);
  });

  it('does not disturb the regular period or its unique index', async () => {
    const list = (await get(`/api/buildings/${A.buildingId}/periods`)).json().rows as { id: string; period: string; kind: string; status: string }[];
    expect(list.filter((p) => p.kind === 'extraordinary')).toHaveLength(2);
    expect(list.filter((p) => p.kind === 'regular')).toHaveLength(1);
    const again = await post(`/api/buildings/${A.buildingId}/periods`, { period: '2026-09' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('period_exists');
  });

  it('refuses a distribution that reaches no unit, and another tenant', async () => {
    const none = await post(`/api/buildings/${A.buildingId}/extraordinary-costs`, {
      description: 'Ништо', amountMinor: 1000, fund: 'regular', distribution: 'equal', appliesTo: ['other'], dueDays: 15,
    });
    expect(none.statusCode).toBe(400);
    expect(none.json().error.code).toBe('no_units');
    // The refused attempt left no period behind.
    expect(((await get(`/api/buildings/${A.buildingId}/periods`)).json().rows as unknown[])).toHaveLength(3);
    const other = await post(`/api/buildings/${A.buildingId}/extraordinary-costs`, {
      description: 'x', amountMinor: 1000, fund: 'regular', distribution: 'equal', dueDays: 15,
    }, b.cookie);
    expect(other.statusCode).toBe(404);
  });
});
