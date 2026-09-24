import { schema } from '@domar/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashPassword } from '../src/auth/password.js';
import { extraordinaryPeriodFor } from '../src/resources/extraordinary/service.js';
import type * as PublishModule from '../src/resources/invoicing/publish.js';
import { setupPublishedBuilding } from './billing-fixture.js';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

/** Lets one test simulate a publish that dies after the invoices were generated. Off by default. */
const stub = vi.hoisted(() => ({ failPublish: false }));
vi.mock('../src/resources/invoicing/publish.js', async (importOriginal) => {
  const actual = await importOriginal<typeof PublishModule>();
  return {
    ...actual,
    publishPeriod: async (...args: Parameters<typeof actual.publishPeriod>) => {
      if (stub.failPublish) throw new Error('simulated publish failure');
      return actual.publishPeriod(...args);
    },
  };
});

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

  it('refuses a distribution that would reach a unit nobody owns', async () => {
    // No appliesTo = every unit kind, and the fixture's storage unit S-1 has no owner: its slice
    // would be computed and then dropped, quietly leaving the owners short of the full amount.
    const res = await post(`/api/buildings/${A.buildingId}/extraordinary-costs`, {
      description: 'Фасада', amountMinor: 500000, fund: 'reserve', distribution: 'equal', dueDays: 30,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('missing_owner');
    expect(res.json().error.details.units).toEqual(['S-1']);
    expect(((await get(`/api/buildings/${A.buildingId}/periods`)).json().rows as unknown[])).toHaveLength(3);
  });

  it('refuses an area distribution over a unit with no area', async () => {
    const res = await post(`/api/buildings/${A.buildingId}/extraordinary-costs`, {
      description: 'Кровна изолација', amountMinor: 500000, fund: 'reserve', distribution: 'area',
      appliesTo: ['apartment', 'commercial', 'parking'], dueDays: 30,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('missing_unit_data');
    expect(res.json().error.details).toEqual({ field: 'areaM2', units: ['P-1'] });
  });

  it('refuses a readonly user', async () => {
    await t.db.insert(schema.users).values({
      tenantId: a.tenantId, email: 'ro@firma-extra.mk', passwordHash: await hashPassword('correct-horse-1'),
      firstName: 'R', lastName: 'O', role: 'readonly',
    });
    const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantSlug: 'firma-extra', email: 'ro@firma-extra.mk', password: 'correct-horse-1' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const res = await post(`/api/buildings/${A.buildingId}/extraordinary-costs`, {
      description: 'x', amountMinor: 1000, fund: 'regular', distribution: 'equal', appliesTo: ['apartment'], dueDays: 15,
    }, cookie);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
  });

  it('splits an area distribution by each unit area', async () => {
    // 450.000 over 50 m², 75 m² and 100 m² = 225 m²: 2.000 per m², exactly and with no remainder.
    const res = await post(`/api/buildings/${A.buildingId}/extraordinary-costs`, {
      description: 'Хидроизолација', amountMinor: 450000, fund: 'reserve', distribution: 'area',
      appliesTo: ['apartment', 'commercial'], dueDays: 30,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().totalMinor).toBe(450000);
    const rows = await invoicesOf(res.json().periodId);
    const byOwner = Object.fromEntries(rows.map((r) => [r.contactId, r]));
    expect(byOwner[A.owners.O1]!.totalMinor).toBe(100000);
    expect(byOwner[A.owners.O2]!.totalMinor).toBe(150000);
    expect(byOwner[A.owners.O3]!.totalMinor).toBe(200000);
    const period = (await get(`/api/buildings/${A.buildingId}/periods/${res.json().periodId}`)).json();
    expect(period.distributionBasis).toBe('area');
  });

  it('bills an attached unit to the unit it hangs off, and the owners carry the whole amount', async () => {
    // P-1 hangs off unit 1, so its quarter lands on O1: four equal quarters, none of them lost.
    const res = await post(`/api/buildings/${A.buildingId}/extraordinary-costs`, {
      description: 'Порта на паркинг', amountMinor: 400000, fund: 'regular', distribution: 'equal',
      appliesTo: ['apartment', 'commercial', 'parking'], dueDays: 30,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().totalMinor).toBe(400000);
    const rows = await invoicesOf(res.json().periodId);
    expect(rows.reduce((s, r) => s + r.totalMinor, 0)).toBe(400000);
    const byOwner = Object.fromEntries(rows.map((r) => [r.contactId, r]));
    expect(byOwner[A.owners.O1]!.totalMinor).toBe(200000);
    expect(byOwner[A.owners.O2]!.totalMinor).toBe(100000);
    expect(byOwner[A.owners.O3]!.totalMinor).toBe(100000);
  });

  it('refuses a second distribution while an earlier one is unpublished, and publishing it writes the event', async () => {
    stub.failPublish = true;
    const boom = await post(`/api/buildings/${A.buildingId}/extraordinary-costs`, {
      description: 'Скали', amountMinor: 300000, fund: 'regular', distribution: 'equal', appliesTo: ['apartment', 'commercial'], dueDays: 20,
    });
    expect(boom.statusCode).toBe(500);
    stub.failPublish = false;

    const blocked = await post(`/api/buildings/${A.buildingId}/extraordinary-costs`, {
      description: 'Друго', amountMinor: 1000, fund: 'regular', distribution: 'equal', appliesTo: ['apartment'], dueDays: 15,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('extraordinary_pending');
    const stranded: string = blocked.json().error.details.periodId;

    // The manager finishes it from the period page: the legal event is written by the publish itself.
    const done = await post(`/api/buildings/${A.buildingId}/periods/${stranded}/publish`, {});
    expect(done.statusCode).toBe(200);
    const events = (await get(`/api/buildings/${A.buildingId}/legal-events?pageSize=200`)).json().rows
      .filter((e: { kind: string; refId: string }) => e.kind === 'extraordinary_cost_distributed' && e.refId === stranded);
    expect(events).toHaveLength(1);
    expect(events[0].evidence.amountMinor).toBe(300000);
    expect(events[0].evidence.distribution).toBe('equal');
    expect(events[0].evidence.invoiceCount).toBe(3);
    expect(events[0].evidence.totalMinor).toBe(300000);
  });

  it('lets the manager delete a stranded period and try again', async () => {
    stub.failPublish = true;
    expect((await post(`/api/buildings/${A.buildingId}/extraordinary-costs`, {
      description: 'Портафон', amountMinor: 300000, fund: 'regular', distribution: 'equal', appliesTo: ['apartment', 'commercial'], dueDays: 20,
    })).statusCode).toBe(500);
    stub.failPublish = false;

    const blocked = await post(`/api/buildings/${A.buildingId}/extraordinary-costs`, {
      description: 'Портафон', amountMinor: 300000, fund: 'regular', distribution: 'equal', appliesTo: ['apartment', 'commercial'], dueDays: 20,
    });
    expect(blocked.statusCode).toBe(409);
    const stranded: string = blocked.json().error.details.periodId;
    const del = await t.app.inject({ method: 'DELETE', url: `/api/buildings/${A.buildingId}/periods/${stranded}`, headers: { cookie: a.cookie } });
    expect(del.statusCode).toBe(204);
    expect((await get(`/api/buildings/${A.buildingId}/periods/${stranded}`)).statusCode).toBe(404);

    const again = await post(`/api/buildings/${A.buildingId}/extraordinary-costs`, {
      description: 'Портафон', amountMinor: 300000, fund: 'regular', distribution: 'equal', appliesTo: ['apartment', 'commercial'], dueDays: 20,
    });
    expect(again.statusCode).toBe(201);
    // A published period is not deletable, and neither is a regular month.
    const locked = await t.app.inject({ method: 'DELETE', url: `/api/buildings/${A.buildingId}/periods/${again.json().periodId}`, headers: { cookie: a.cookie } });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error.code).toBe('period_locked');
    const regular = await t.app.inject({ method: 'DELETE', url: `/api/buildings/${A.buildingId}/periods/${A.periodId}`, headers: { cookie: a.cookie } });
    expect(regular.statusCode).toBe(409);
  });

  it('two concurrent distributions bill the owners once: one 201, one 409', async () => {
    const C = await setupPublishedBuilding(t.app, a.cookie);
    const payload = {
      description: 'Лифт', amountMinor: 300000, fund: 'regular',
      distribution: 'equal', appliesTo: ['apartment', 'commercial'], dueDays: 15,
    };
    const [r1, r2] = await Promise.all([
      post(`/api/buildings/${C.buildingId}/extraordinary-costs`, payload),
      post(`/api/buildings/${C.buildingId}/extraordinary-costs`, payload),
    ]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([201, 409]);
    const loser = r1.statusCode === 409 ? r1 : r2;
    expect(loser.json().error.code).toBe('extraordinary_pending');

    const extra = (await get(`/api/buildings/${C.buildingId}/periods`)).json().rows
      .filter((p: { kind: string }) => p.kind === 'extraordinary');
    expect(extra).toHaveLength(1);
    const invoices = (await get(`/api/invoices?buildingId=${C.buildingId}&pageSize=200`)).json().rows
      .filter((r: InvoiceRow) => r.periodId === extra[0].id);
    expect(invoices).toHaveLength(3);
    expect(invoices.reduce((sum: number, r: InvoiceRow) => sum + r.totalMinor, 0)).toBe(300000);
  });

  it('dates the charge to this month, or the next when this month is already invoiced', async () => {
    const ctx = { tenantId: a.tenantId, userId: a.userId, role: 'owner' as const };
    // The fixture published the regular 2026-09 period, so September is out of reach.
    expect(await extraordinaryPeriodFor(t.db, ctx, A.buildingId, 'Europe/Skopje', new Date('2026-09-15T10:00:00Z'))).toBe('2026-10');
    expect(await extraordinaryPeriodFor(t.db, ctx, A.buildingId, 'Europe/Skopje', new Date('2026-12-31T23:30:00Z'))).toBe('2027-01');
    expect(await extraordinaryPeriodFor(t.db, ctx, A.buildingId, 'Europe/Skopje', new Date('2026-11-05T08:00:00Z'))).toBe('2026-11');
  });
});
