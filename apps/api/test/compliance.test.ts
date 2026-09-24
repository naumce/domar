import { schema } from '@domar/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('playwright-core', () => {
  const launch = vi.fn(async () => ({
    isConnected: () => true,
    newContext: async () => ({ newPage: async () => ({ setContent: async () => {}, pdf: async () => Buffer.from('%PDF-reminder') }), close: async () => {} }),
    close: async () => {},
  }));
  return { chromium: { launch } };
});

import { hashPassword } from '../src/auth/password.js';
import { setupPublishedBuilding } from './billing-fixture.js';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

interface Duty { key: string; article: string; status: string; dueAt: string | null; lastEvidenceAt: string | null; howToFix: string; count: number | null; label: string; hint: string }

describe('compliance', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let b: Awaited<ReturnType<typeof registerTenant>>;
  let A: Awaited<ReturnType<typeof setupPublishedBuilding>>;
  let B: Awaited<ReturnType<typeof setupPublishedBuilding>>;
  let readonlyCookie = '';

  const post = (url: string, payload: Record<string, unknown> = {}, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? a.cookie }, payload });
  const get = (url: string, cookie?: string) => t.app.inject({ method: 'GET', url, headers: { cookie: cookie ?? a.cookie } });
  const statuses = async (buildingId: string): Promise<Record<string, string>> => {
    const body = (await get(`/api/buildings/${buildingId}/compliance`)).json();
    return Object.fromEntries(body.duties.map((d: Duty) => [d.key, d.status]));
  };
  const duty = async (buildingId: string, key: string): Promise<Duty> =>
    (await get(`/api/buildings/${buildingId}/compliance`)).json().duties.find((d: Duty) => d.key === key);

  beforeAll(async () => {
    t = await createTestApp({ SMTP_URL: 'json' });
    a = await registerTenant(t.app, 'firma-comp');
    b = await registerTenant(t.app, 'firma-comp-other');
    A = await setupPublishedBuilding(t.app, a.cookie); // published today, due in 15 days
    const passwordHash = await hashPassword('correct-horse-1');
    await t.db.insert(schema.users).values({ tenantId: a.tenantId, email: 'ro@firma-comp.mk', passwordHash, firstName: 'R', lastName: 'O', role: 'readonly' });
    const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantSlug: 'firma-comp', email: 'ro@firma-comp.mk', password: 'correct-horse-1' } });
    const raw = login.headers['set-cookie'];
    readonlyCookie = String(Array.isArray(raw) ? raw[0] : raw).split(';')[0]!;
  });
  afterAll(async () => {
    const m = await import('../src/pdf/html-to-pdf.js');
    await m.closePdfBrowser();
    m._resetForTests();
    await t.close();
  });

  it('a freshly published building owes its accounts and its fund transparency', async () => {
    expect(await statuses(A.buildingId)).toEqual({
      invoices: 'ok', reminders: 'ok', assembly: 'n/a', annual_report: 'n/a',
      fund_transparency: 'due', fund_accounts: 'overdue', handover: 'n/a', extraordinary_costs: 'n/a',
    });
    const body = (await get(`/api/buildings/${A.buildingId}/compliance`)).json();
    expect(body.status).toBe('overdue');
    expect(body.counts).toEqual({ ok: 2, due: 1, overdue: 1, na: 4 });
    expect(body.building).toEqual({ id: A.buildingId, name: 'Партизанска 12' });
    expect(typeof body.evaluatedAt).toBe('string');
  });

  it('carries the article, the deep link and the Macedonian label of every duty', async () => {
    const d = await duty(A.buildingId, 'fund_accounts');
    expect(d.article).toBe('42/45');
    expect(d.howToFix).toBe('?tab=compliance#fund-accounts');
    expect(d.label).toBe('Одвоени сметки за фондовите');
    expect(d.hint).toBe('Внесете ги броевите на сметките на редовниот и на резервниот фонд.');
    const inv = await duty(A.buildingId, 'invoices');
    expect(inv.article).toBe('19/33');
    expect(inv.lastEvidenceAt).not.toBeNull();
    expect(inv.dueAt).not.toBeNull();
  });

  it('turns fund_accounts green when both account numbers are filled in', async () => {
    const res = await t.app.inject({ method: 'PATCH', url: `/api/buildings/${A.buildingId}`, headers: { cookie: a.cookie },
      payload: { regularFundAccount: '210-0000000000-19', reserveFundAccount: '210-0000000000-96' } });
    expect(res.statusCode).toBe(200);
    const s = await statuses(A.buildingId);
    expect(s.fund_accounts).toBe('ok');
    expect(s.fund_transparency).toBe('due');
    expect((await get(`/api/buildings/${A.buildingId}/compliance`)).json().status).toBe('due');
  });

  it('turns fund_transparency green when the first owner links to the portal', async () => {
    await t.app.inject({ method: 'PATCH', url: `/api/contacts/${A.owners.O1}`, headers: { cookie: a.cookie }, payload: { email: 'marko@firma-comp.mk' } });
    const invite = (await post(`/api/contacts/${A.owners.O1}/portal-invite`)).json();
    const reg = await t.app.inject({ method: 'POST', url: '/api/portal/register', payload: { code: invite.code, email: 'marko.owner@firma-comp.mk', password: 'correct-horse-1' } });
    expect(reg.statusCode).toBe(201);
    const d = await duty(A.buildingId, 'fund_transparency');
    expect(d.status).toBe('ok');
    expect(d.count).toBe(1);
    expect(d.lastEvidenceAt).not.toBeNull();
    expect((await get(`/api/buildings/${A.buildingId}/compliance`)).json().status).toBe('ok');
  });

  it('turns reminders amber while owners are over the Art. 28 threshold and green once they are reminded', async () => {
    B = await setupPublishedBuilding(t.app, a.cookie, { dueAt: daysAgo(20) });
    // An owner without an email gets a letter, which stays pending until printed; give every owner
    // an address so the run delivers by email and the legal event lands before the response returns.
    for (const k of ['O1', 'O2', 'O3'] as const) {
      await t.app.inject({ method: 'PATCH', url: `/api/contacts/${B.owners[k]}`, headers: { cookie: a.cookie }, payload: { email: `${k.toLowerCase()}@firma-comp-other.mk` } });
    }
    const p10 = (await post(`/api/buildings/${B.buildingId}/periods`, { period: '2026-10' })).json().id;
    await post(`/api/buildings/${B.buildingId}/periods/${p10}/generate`);
    await post(`/api/buildings/${B.buildingId}/periods/${p10}/publish`, { dueAt: daysAgo(10) });

    const before = await duty(B.buildingId, 'reminders');
    expect(before.status).toBe('due');
    expect(before.count).toBe(3);
    expect(before.dueAt).not.toBeNull();
    expect(before.lastEvidenceAt).toBeNull();

    const created = (await post(`/api/buildings/${B.buildingId}/reminders/run`)).json().rows;
    expect(created).toHaveLength(3);
    const after = await duty(B.buildingId, 'reminders');
    expect(after.status).toBe('ok');
    expect(after.count).toBe(0);
    expect(after.lastEvidenceAt).not.toBeNull();
  });

  it('lists every building of the tenant with its worst status', async () => {
    const body = (await get('/api/compliance')).json();
    expect(body.rows).toHaveLength(2);
    const byId = Object.fromEntries(body.rows.map((r: { building: { id: string } }) => [r.building.id, r]));
    expect(byId[A.buildingId].status).toBe('ok');
    expect(byId[B.buildingId].status).toBe('overdue'); // B still has no fund accounts
    expect(byId[B.buildingId].duties.find((d: { key: string }) => d.key === 'fund_accounts').status).toBe('overdue');
    expect(byId[B.buildingId].duties).toHaveLength(8);
    expect(Object.keys(byId[B.buildingId].duties[0])).toEqual(['key', 'status']);
    expect(body.counts).toEqual({ ok: 1, due: 0, overdue: 1, na: 0 });
  });

  it('is readable by a readonly user and invisible to another tenant', async () => {
    expect((await get(`/api/buildings/${A.buildingId}/compliance`, readonlyCookie)).statusCode).toBe(200);
    expect((await get('/api/compliance', readonlyCookie)).statusCode).toBe(200);
    expect((await get(`/api/buildings/${A.buildingId}/compliance`, b.cookie)).statusCode).toBe(404);
    expect((await get('/api/compliance', b.cookie)).json().rows).toEqual([]);
  });

  it('dates the reminder deadline from the invoice that crossed the threshold, not the oldest unpaid one', async () => {
    // Two unpaid months: the owner is over the Art. 28 threshold only once the *second* falls due,
    // so the 30 days run from that one — on the first day a reminder is owed the duty is `due`.
    const D = await setupPublishedBuilding(t.app, a.cookie, { dueAt: daysAgo(40) });
    const dp = (await post(`/api/buildings/${D.buildingId}/periods`, { period: '2026-10' })).json().id;
    await post(`/api/buildings/${D.buildingId}/periods/${dp}/generate`);
    await post(`/api/buildings/${D.buildingId}/periods/${dp}/publish`, { dueAt: daysAgo(1) });
    const fresh = await duty(D.buildingId, 'reminders');
    expect(fresh.status).toBe('due');
    expect(Date.parse(fresh.dueAt!)).toBeGreaterThan(Date.now());

    // Thirty days after that second invoice fell due, the same duty is overdue.
    const E = await setupPublishedBuilding(t.app, a.cookie, { dueAt: daysAgo(70) });
    const ep = (await post(`/api/buildings/${E.buildingId}/periods`, { period: '2026-10' })).json().id;
    await post(`/api/buildings/${E.buildingId}/periods/${ep}/generate`);
    await post(`/api/buildings/${E.buildingId}/periods/${ep}/publish`, { dueAt: daysAgo(32) });
    expect((await duty(E.buildingId, 'reminders')).status).toBe('overdue');
  });

  it('never shows a failed reminder send as evidence, only a delivered one', async () => {
    const C = await setupPublishedBuilding(t.app, a.cookie, { dueAt: daysAgo(20) });
    for (const k of ['O1', 'O2', 'O3'] as const) {
      await t.app.inject({ method: 'PATCH', url: `/api/contacts/${C.owners[k]}`, headers: { cookie: a.cookie }, payload: { email: `${k.toLowerCase()}@firma-comp.mk` } });
    }
    const p10 = (await post(`/api/buildings/${C.buildingId}/periods`, { period: '2026-10' })).json().id;
    await post(`/api/buildings/${C.buildingId}/periods/${p10}/generate`);
    await post(`/api/buildings/${C.buildingId}/periods/${p10}/publish`, { dueAt: daysAgo(10) });

    const send = vi.spyOn(t.app.mailer, 'send').mockResolvedValue({ error: 'connection refused' });
    const rows: { id: string; status: string }[] = (await post(`/api/buildings/${C.buildingId}/reminders/run`)).json().rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.status === 'failed')).toBe(true);
    send.mockRestore();

    const before = await duty(C.buildingId, 'reminders');
    expect(before.lastEvidenceAt).toBeNull();

    const resent = await post(`/api/reminders/${rows[0]!.id}/resend`);
    expect(resent.json().status).toBe('sent');

    const after = await duty(C.buildingId, 'reminders');
    expect(after.lastEvidenceAt).not.toBeNull();
  });
});
