import { schema } from '@domar/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

describe('generate and publish', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let buildingId: string; let vatId: string; let periodId: string;
  const owners: Record<string, string> = {};
  const h = () => ({ cookie: a.cookie });
  const P = (s = '') => `/api/buildings/${buildingId}/periods${s}`;
  const post = (url: string, payload: Record<string, unknown>) => t.app.inject({ method: 'POST', url, headers: h(), payload });

  beforeAll(async () => {
    t = await createTestApp();
    a = await registerTenant(t.app, 'firma-a');
    vatId = (await t.app.inject({ method: 'GET', url: '/api/tax-rates', headers: h() })).json().rows.find((r: { rateBp: number }) => r.rateBp === 1800).id;
    for (const [k, ln] of [['O1', 'Анѓеловски'], ['O2', 'Бошковски'], ['O3', 'Велковски']] as const) {
      owners[k] = (await post('/api/contacts', { firstName: 'Тест', lastName: ln })).json().id;
    }
    buildingId = (await post('/api/buildings', { name: 'Партизанска 12', shareBasis: 'area' })).json().id;
    const U = (p: Record<string, unknown>) => post(`/api/buildings/${buildingId}/units`, p);
    const A = (await U({ label: '1', kind: 'apartment', areaM2: 50, ownerContactId: owners.O1 })).json().id;
    await U({ label: '2', kind: 'apartment', areaM2: 75, ownerContactId: owners.O2 });
    await U({ label: 'L1', kind: 'commercial', areaM2: 100, ownerContactId: owners.O3 });
    await U({ label: 'P-1', kind: 'parking', attachedToUnitId: A });
    await U({ label: 'S-1', kind: 'storage', areaM2: 10 });
    const cleaning = (await post('/api/services', { name: 'Чистење', pricing: 'fixed_per_unit', defaultPriceMinor: 30000, taxRateId: vatId, appliesTo: ['apartment', 'commercial'] })).json().id;
    const lift = (await post('/api/services', { name: 'Лифт', pricing: 'shared_total', defaultPriceMinor: 600000, taxRateId: vatId })).json().id;
    await post(`/api/buildings/${buildingId}/services`, { serviceId: cleaning, startsPeriod: '2026-01' });
    await post(`/api/buildings/${buildingId}/services`, { serviceId: lift, startsPeriod: '2026-01' });
    await t.app.inject({ method: 'PUT', url: `/api/buildings/${buildingId}/reserve-fund`, headers: h(), payload: { basis: 'per_m2', amountMinor: 1000, appliesTo: ['apartment', 'commercial'], active: true } });
    await post(`/api/buildings/${buildingId}/reserve-fund/opening-balance`, { amountMinor: 3500000 });
    const period = await post(P(), { period: '2026-09', managementFeeMinor: 15000, managementFeeTaxRateId: vatId });
    periodId = period.json().id;
    await post(P(`/${periodId}/lines`), { description: 'Осветлување паркинг', pricing: 'fixed_per_unit', unitPriceMinor: 2000, taxRateId: vatId, appliesTo: ['parking'] });
  });
  afterAll(async () => { await t.close(); });

  it('generates one draft per owner with the engine totals and no postings', async () => {
    const gen = await post(P(`/${periodId}/generate`), {});
    expect(gen.statusCode).toBe(200);
    expect(gen.json()).toMatchObject({ invoiceCount: 3, totalMinor: 256099 + 354057 + 454376 });
    expect(gen.json().warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'missing_area' }), expect.objectContaining({ code: 'no_owner' })]));
    expect(gen.json().period.status).toBe('generated');
    const list = await t.app.inject({ method: 'GET', url: `/api/invoices?buildingId=${buildingId}&period=2026-09`, headers: h() });
    expect(list.json().total).toBe(3);
    const o1 = list.json().rows.find((i: { contactId: string }) => i.contactId === owners.O1);
    expect(o1).toMatchObject({ status: 'draft', number: null, subtotalMinor: 224660, taxMinor: 31439, totalMinor: 256099, previousBalanceMinor: 0, amountDueMinor: 256099, reserveFundBuildingBalanceMinor: 3500000, currency: 'MKD' });
    const postings = await t.db.query.postings.findMany();
    expect(postings.filter((p) => p.kind === 'charge')).toHaveLength(0);
  });

  it('regenerates idempotently (drafts replaced, still 3)', async () => {
    const before = (await t.app.inject({ method: 'GET', url: `/api/invoices?buildingId=${buildingId}`, headers: h() })).json().rows.map((i: { id: string }) => i.id).sort();
    const gen = await post(P(`/${periodId}/generate`), {});
    expect(gen.json().invoiceCount).toBe(3);
    const after = (await t.app.inject({ method: 'GET', url: `/api/invoices?buildingId=${buildingId}`, headers: h() })).json().rows.map((i: { id: string }) => i.id).sort();
    expect(after).toHaveLength(3);
    expect(after).not.toEqual(before);
  });

  it('shows invoice detail with Art. 33 lines', async () => {
    const list = (await t.app.inject({ method: 'GET', url: `/api/invoices?buildingId=${buildingId}`, headers: h() })).json().rows;
    const o1 = list.find((i: { contactId: string }) => i.contactId === owners.O1);
    const detail = (await t.app.inject({ method: 'GET', url: `/api/invoices/${o1.id}`, headers: h() })).json();
    expect(detail.lines).toHaveLength(5);
    expect(detail.lines.map((l: { kind: string }) => l.kind).sort()).toEqual(['management_fee', 'manual', 'reserve_fund', 'service', 'service']);
    const lift = detail.lines.find((l: { description: string }) => l.description === 'Лифт');
    expect(lift).toMatchObject({ buildingWideNetMinor: 600000, ownerNetMinor: 127660, ownerTaxMinor: 22979, ownerGrossMinor: 150639, unitLabel: '1' });
    expect(detail.contact.lastName).toBe('Анѓеловски');
    expect(detail.building.name).toBe('Партизанска 12');
    expect(detail.period).toBe('2026-09');
  });

  it('publishes: numbers, dates, postings, balances', async () => {
    const pub = await post(P(`/${periodId}/publish`), {});
    expect(pub.statusCode).toBe(200);
    expect(pub.json().period.status).toBe('published');
    const rows = (await t.app.inject({ method: 'GET', url: `/api/invoices?buildingId=${buildingId}&status=published`, headers: h() })).json().rows;
    expect(rows.map((i: { number: string }) => i.number).sort()).toEqual(['INV-0001/2026', 'INV-0002/2026', 'INV-0003/2026']);
    expect(rows.every((i: { issuedAt: string | null; dueAt: string | null }) => i.issuedAt && i.dueAt)).toBe(true);
    const due = new Date(rows[0].dueAt).getTime() - new Date(rows[0].issuedAt).getTime();
    expect(due).toBe(15 * 24 * 3600 * 1000);
    const charges = (await t.db.query.postings.findMany()).filter((p) => p.kind === 'charge');
    expect(charges.reduce((s, p) => s + p.amountMinor, 0)).toBe(256099 + 354057 + 454376);
    expect(charges.filter((p) => p.fund === 'reserve').reduce((s, p) => s + p.amountMinor, 0)).toBe(225000);
    const rf = (await t.app.inject({ method: 'GET', url: `/api/buildings/${buildingId}/reserve-fund`, headers: h() })).json();
    expect(rf).toMatchObject({ balanceMinor: 3500000, contributionsBilledMinor: 225000 });
    const html = await t.app.inject({ method: 'GET', url: `/api/invoices/${rows[0].id}/html`, headers: h() });
    expect(html.statusCode).toBe(200);
    expect(html.headers['content-type']).toMatch(/^text\/html/);
    expect(html.body).toContain(rows[0].number);
    expect(html.body).toContain('Резервен фонд');
    expect((await post(P(`/${periodId}/publish`), {})).statusCode).toBe(409);
    expect((await post(P(`/${periodId}/lines`), { description: 'x', pricing: 'fixed_per_unit', unitPriceMinor: 1 })).json().error.code).toBe('period_locked');
  });

  it('carries the previous balance into the next period and continues numbering', async () => {
    const oct = (await post(P(), { period: '2026-10' })).json();
    await post(P(`/${oct.id}/generate`), {});
    const rows = (await t.app.inject({ method: 'GET', url: `/api/invoices?buildingId=${buildingId}&period=2026-10`, headers: h() })).json().rows;
    const o1 = rows.find((i: { contactId: string }) => i.contactId === owners.O1);
    expect(o1.previousBalanceMinor).toBe(256099);
    expect(o1.amountDueMinor).toBe(o1.totalMinor + 256099);
    await post(P(`/${oct.id}/publish`), {});
    const numbers = (await t.app.inject({ method: 'GET', url: `/api/invoices?buildingId=${buildingId}&period=2026-10`, headers: h() })).json().rows.map((i: { number: string }) => i.number).sort();
    expect(numbers).toEqual(['INV-0004/2026', 'INV-0005/2026', 'INV-0006/2026']);
  });

  it('editing a generated period drops its stale drafts and regenerates with the new line', async () => {
    const dec = (await post(P(), { period: '2026-12' })).json();
    expect((await post(P(`/${dec.id}/generate`), {})).json().invoiceCount).toBe(3);
    const before = (await t.app.inject({ method: 'GET', url: `/api/invoices?buildingId=${buildingId}&period=2026-12`, headers: h() })).json().rows.find((i: { contactId: string }) => i.contactId === owners.O1);
    const beforeLines = (await t.app.inject({ method: 'GET', url: `/api/invoices/${before.id}`, headers: h() })).json().lines.length;
    expect((await post(P(`/${dec.id}/lines`), { description: 'Дезинфекција', pricing: 'fixed_per_unit', unitPriceMinor: 5000, appliesTo: ['apartment'] })).statusCode).toBe(201);
    const reopened = (await t.app.inject({ method: 'GET', url: P(`/${dec.id}`), headers: h() })).json();
    expect(reopened).toMatchObject({ status: 'open', invoiceCount: 0, generatedAt: null, warnings: [] });
    expect((await post(P(`/${dec.id}/generate`), {})).json().invoiceCount).toBe(3);
    const after = (await t.app.inject({ method: 'GET', url: `/api/invoices?buildingId=${buildingId}&period=2026-12`, headers: h() })).json().rows.find((i: { contactId: string }) => i.contactId === owners.O1);
    const afterLines = (await t.app.inject({ method: 'GET', url: `/api/invoices/${after.id}`, headers: h() })).json().lines;
    expect(afterLines).toHaveLength(beforeLines + 1);
    expect(afterLines.filter((l: { description: string }) => l.description === 'Дезинфекција')).toHaveLength(1);
  });

  it('keeps drafts on a numbering-only patch', async () => {
    const jan = (await post(P(), { period: '2027-01' })).json();
    expect((await post(P(`/${jan.id}/generate`), {})).json().invoiceCount).toBe(3);
    const numbering = await t.app.inject({ method: 'PATCH', url: P(`/${jan.id}`), headers: h(), payload: { numberPrefix: 'R-' } });
    expect(numbering.json()).toMatchObject({ status: 'generated', invoiceCount: 3 });
    const fee = await t.app.inject({ method: 'PATCH', url: P(`/${jan.id}`), headers: h(), payload: { managementFeeMinor: 20000 } });
    expect(fee.json()).toMatchObject({ status: 'open', invoiceCount: 0 });
  });

  it('rejects a line whose total exceeds the supported maximum', async () => {
    const feb = (await post(P(), { period: '2027-02' })).json();
    const res = await post(P(`/${feb.id}/lines`), { description: 'x', pricing: 'fixed_per_unit', unitPriceMinor: 1_000_000_000_000, quantity: 10 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation');
  });

  it('refuses to delete a published invoice, deletes drafts, and is tenant isolated', async () => {
    const pubRows = (await t.app.inject({ method: 'GET', url: `/api/invoices?status=published`, headers: h() })).json().rows;
    const refused = await t.app.inject({ method: 'DELETE', url: `/api/invoices/${pubRows[0].id}`, headers: h() });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('not_draft');
    const nov = (await post(P(), { period: '2026-11' })).json();
    await post(P(`/${nov.id}/generate`), {});
    const drafts = (await t.app.inject({ method: 'GET', url: `/api/invoices?period=2026-11`, headers: h() })).json().rows;
    expect((await t.app.inject({ method: 'DELETE', url: `/api/invoices/${drafts[0].id}`, headers: h() })).statusCode).toBe(204);
    const del = await t.app.inject({ method: 'DELETE', url: P(`/${nov.id}/drafts`), headers: h() });
    expect(del.statusCode).toBe(200);
    expect(del.json().status).toBe('open');
    expect((await t.app.inject({ method: 'GET', url: `/api/invoices?period=2026-11`, headers: h() })).json().total).toBe(0);
    expect((await post(P(`/${nov.id}/publish`), {})).json().error.code).toBe('nothing_to_publish');
    const b = await registerTenant(t.app, 'firma-b');
    expect((await t.app.inject({ method: 'GET', url: `/api/invoices/${pubRows[0].id}`, headers: { cookie: b.cookie } })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: '/api/invoices', headers: { cookie: b.cookie } })).json().total).toBe(0);
  });
});

describe('concurrent generate/publish', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let buildingId: string;
  const h = () => ({ cookie: a.cookie });
  const P = (s = '') => `/api/buildings/${buildingId}/periods${s}`;
  const post = (url: string, payload: Record<string, unknown>) => t.app.inject({ method: 'POST', url, headers: h(), payload });

  beforeAll(async () => {
    t = await createTestApp();
    a = await registerTenant(t.app, 'firma-race');
    const owner = (await post('/api/contacts', { firstName: 'Тест', lastName: 'Раце' })).json().id;
    buildingId = (await post('/api/buildings', { name: 'Race building', shareBasis: 'equal' })).json().id;
    await post(`/api/buildings/${buildingId}/units`, { label: '1', kind: 'apartment', areaM2: 50, ownerContactId: owner });
    const svc = (await post('/api/services', { name: 'Услуга', pricing: 'fixed_per_unit', defaultPriceMinor: 10000 })).json().id;
    await post(`/api/buildings/${buildingId}/services`, { serviceId: svc, startsPeriod: '2026-01' });
  });
  afterAll(async () => { await t.close(); });

  it('concurrent publish: exactly one succeeds, no double postings, numbers unique', async () => {
    const period = (await post(P(), { period: '2026-01' })).json();
    await post(P(`/${period.id}/generate`), {});
    const [r1, r2] = await Promise.all([post(P(`/${period.id}/publish`), {}), post(P(`/${period.id}/publish`), {})]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 409]);
    const rows = (await t.app.inject({ method: 'GET', url: `/api/invoices?buildingId=${buildingId}&period=2026-01`, headers: h() })).json().rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('published');
    const numbers = new Set(rows.map((r: { number: string | null }) => r.number));
    expect(numbers.size).toBe(1);
    const charges = (await t.db.query.postings.findMany()).filter((p) => p.kind === 'charge' && p.refId === rows[0].id);
    expect(charges).toHaveLength(1);
    expect(charges.reduce((s, p) => s + p.amountMinor, 0)).toBe(rows[0].totalMinor);
  });

  it('concurrent generate: no duplicate drafts', async () => {
    const period = (await post(P(), { period: '2026-02' })).json();
    const [r1, r2] = await Promise.all([post(P(`/${period.id}/generate`), {}), post(P(`/${period.id}/generate`), {})]);
    expect([r1.statusCode, r2.statusCode]).toEqual(expect.arrayContaining([200]));
    for (const r of [r1, r2]) expect([200, 409]).toContain(r.statusCode);
    const rows = (await t.app.inject({ method: 'GET', url: `/api/invoices?buildingId=${buildingId}&period=2026-02`, headers: h() })).json().rows;
    expect(rows).toHaveLength(1);
  });

  it('deleting the only draft in a generated period reopens it with cleared warnings', async () => {
    const period = (await post(P(), { period: '2026-03' })).json();
    await post(P(`/${period.id}/generate`), {});
    const rows = (await t.app.inject({ method: 'GET', url: `/api/invoices?buildingId=${buildingId}&period=2026-03`, headers: h() })).json().rows;
    expect(rows).toHaveLength(1);
    const del = await t.app.inject({ method: 'DELETE', url: `/api/invoices/${rows[0].id}`, headers: h() });
    expect(del.statusCode).toBe(204);
    const after = await t.app.inject({ method: 'GET', url: P(`/${period.id}`), headers: h() });
    expect(after.json().status).toBe('open');
    expect(after.json().warnings).toEqual([]);
  });
});

describe('concurrent publish and draft deletion', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let buildingId: string; let periodId: string; let draftId: string;
  const h = () => ({ cookie: a.cookie });
  const P = (s = '') => `/api/buildings/${buildingId}/periods${s}`;
  const post = (url: string, payload: Record<string, unknown>) => t.app.inject({ method: 'POST', url, headers: h(), payload });

  beforeAll(async () => {
    t = await createTestApp();
    a = await registerTenant(t.app, 'firma-del');
    const owner = (await post('/api/contacts', { firstName: 'Тест', lastName: 'Бришење' })).json().id;
    buildingId = (await post('/api/buildings', { name: 'Delete race', shareBasis: 'equal' })).json().id;
    await post(`/api/buildings/${buildingId}/units`, { label: '1', kind: 'apartment', areaM2: 50, ownerContactId: owner });
    const svc = (await post('/api/services', { name: 'Услуга', pricing: 'fixed_per_unit', defaultPriceMinor: 10000 })).json().id;
    await post(`/api/buildings/${buildingId}/services`, { serviceId: svc, startsPeriod: '2026-01' });
    periodId = (await post(P(), { period: '2026-01' })).json().id;
    await post(P(`/${periodId}/generate`), {});
    draftId = (await t.app.inject({ method: 'GET', url: `/api/invoices?buildingId=${buildingId}&period=2026-01`, headers: h() })).json().rows[0].id;
  });
  afterAll(async () => { await t.close(); });

  it('publishing while the only draft is deleted: one side wins and the period stays consistent', async () => {
    const [pub, del] = await Promise.all([
      post(P(`/${periodId}/publish`), {}),
      t.app.inject({ method: 'DELETE', url: `/api/invoices/${draftId}`, headers: h() }),
    ]);
    expect([[200, 409], [204, 409]]).toContainEqual([pub.statusCode, del.statusCode].sort());
    const rows = (await t.app.inject({ method: 'GET', url: `/api/invoices?buildingId=${buildingId}&period=2026-01`, headers: h() })).json().rows;
    const period = (await t.app.inject({ method: 'GET', url: P(`/${periodId}`), headers: h() })).json();
    const charges = (await t.db.query.postings.findMany()).filter((p) => p.kind === 'charge');
    if (pub.statusCode === 200) {
      // publish won: the invoice is published, numbered and booked exactly once
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: draftId, status: 'published' });
      expect(rows[0].number).toBeTruthy();
      expect(period.status).toBe('published');
      expect(charges.reduce((s, p) => s + p.amountMinor, 0)).toBe(rows[0].totalMinor);
    } else {
      // the deletion won: the draft is gone, the period reopened and nothing was booked
      expect(rows).toHaveLength(0);
      expect(period.status).toBe('open');
      expect(period.warnings).toEqual([]);
      expect(charges).toHaveLength(0);
    }
    expect(period.status).not.toBe('generated');
  });
});

describe('publish with an upper-case building country code', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  afterAll(async () => { await t.close(); });

  // Fix round 1, item 1: `getCountryPack` used to return `undefined` for anything but lowercase
  // `mk`, so a building whose `countryCode` was stored as `MK` published fine right up until the
  // publish transaction tried to format the notification amount, and 500'd there instead. The pack
  // lookup itself is now total and case-insensitive; this reproduces the exact building shape the
  // review found and checks both that publish still returns 200 and that the owner's notification
  // still carries a properly formatted amount — not a try/catch that would have swallowed the write.
  it('publishes 200 and the owner still gets a notification with a formatted amount', async () => {
    t = await createTestApp();
    const a = await registerTenant(t.app, 'firma-mk-upper');
    const h = { cookie: a.cookie };
    const post = (url: string, payload: Record<string, unknown>) => t.app.inject({ method: 'POST', url, headers: h, payload });

    const ownerContactId = (await post('/api/contacts', { firstName: 'Тест', lastName: 'Голем' })).json().id;
    const buildingId = (await post('/api/buildings', { name: 'Голема зграда', shareBasis: 'equal', countryCode: 'MK' })).json().id;
    await post(`/api/buildings/${buildingId}/units`, { label: '1', kind: 'apartment', areaM2: 50, ownerContactId });
    const svc = (await post('/api/services', { name: 'Услуга', pricing: 'fixed_per_unit', defaultPriceMinor: 10000 })).json().id;
    await post(`/api/buildings/${buildingId}/services`, { serviceId: svc, startsPeriod: '2026-01' });

    const code = (await post(`/api/contacts/${ownerContactId}/portal-invite`, {})).json().code;
    const reg = await t.app.inject({ method: 'POST', url: '/api/portal/register', payload: { code, email: 'golem@mk-upper.mk', password: 'correct-horse-1' } });
    expect(reg.statusCode).toBe(201);
    const accountId = reg.json().account.id;

    const period = (await post(`/api/buildings/${buildingId}/periods`, { period: '2026-01' })).json();
    expect((await post(`/api/buildings/${buildingId}/periods/${period.id}/generate`, {})).statusCode).toBe(200);
    const pub = await post(`/api/buildings/${buildingId}/periods/${period.id}/publish`, {});
    expect(pub.statusCode, pub.body).toBe(200);

    const rows = await t.db.select().from(schema.notifications).where(and(
      eq(schema.notifications.tenantId, a.tenantId),
      eq(schema.notifications.ownerAccountId, accountId),
      eq(schema.notifications.kind, 'invoice_published'),
    ));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).not.toMatch(/ден\./);
    expect(rows[0]!.body).toMatch(/ден\./);
  });
});
