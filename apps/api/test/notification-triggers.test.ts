import { schema } from '@domar/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupPublishedBuilding } from './billing-fixture.js';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

describe('notification triggers', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let A: Awaited<ReturnType<typeof setupPublishedBuilding>>;
  let ownerCookie = '';
  let accountId = '';
  let unitId = '';

  const post = (url: string, payload: Record<string, unknown> = {}, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? a.cookie }, payload });
  const get = (url: string) => t.app.inject({ method: 'GET', url, headers: { cookie: a.cookie } });
  const ownerRows = async () => t.db.select().from(schema.notifications)
    .where(and(eq(schema.notifications.tenantId, a.tenantId), eq(schema.notifications.ownerAccountId, accountId)));
  const staffRows = async () => t.db.select().from(schema.notifications)
    .where(and(eq(schema.notifications.tenantId, a.tenantId), eq(schema.notifications.userId, a.userId)));

  beforeAll(async () => {
    t = await createTestApp({ SMTP_URL: 'json' });
    a = await registerTenant(t.app, 'firma-tr');
    A = await setupPublishedBuilding(t.app, a.cookie);
    unitId = (await get(`/api/buildings/${A.buildingId}/units`)).json().rows.find((u: { label: string }) => u.label === '1').id;
    const code = (await post(`/api/contacts/${A.owners.O1}/portal-invite`)).json().code;
    const reg = await t.app.inject({ method: 'POST', url: '/api/portal/register', payload: { code, email: 'o1@tr.mk', password: 'correct-horse-1' } });
    ownerCookie = String(reg.headers['set-cookie']).split(';')[0]!;
    accountId = reg.json().account.id;
  });
  afterAll(async () => { await t.close(); });

  it('a published period notifies every linked owner once, with the amount out of the title', async () => {
    // `setupPublishedBuilding` published before the owner had an account; a second period is the trigger.
    const period = (await post(`/api/buildings/${A.buildingId}/periods`, { period: '2026-10' })).json();
    await post(`/api/buildings/${A.buildingId}/periods/${period.id}/generate`);
    expect((await post(`/api/buildings/${A.buildingId}/periods/${period.id}/publish`)).statusCode).toBe(200);

    const rows = (await ownerRows()).filter((r) => r.kind === 'invoice_published');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toContain('Нова фактура');
    // Spec §11: the amount is in the body, never in the title a phone may show.
    expect(rows[0]!.title).not.toMatch(/ден\./);
    expect(rows[0]!.body).toMatch(/ден\./);
    expect(rows[0]!.link).toMatch(/^\/portal\/invoices\/[0-9a-f-]{36}$/);
    expect(rows[0]!.deliveredAt).toBeNull();
  });

  it('a reminder run notifies the owner it was raised against', async () => {
    // The October invoice is unpaid and past due once the clock is moved by the run's own date.
    await t.db.update(schema.invoices).set({ dueAt: new Date('2020-01-01') })
      .where(eq(schema.invoices.tenantId, a.tenantId));
    expect((await post(`/api/buildings/${A.buildingId}/reminders/run`)).statusCode).toBe(200);
    const rows = (await ownerRows()).filter((r) => r.kind === 'reminder_created');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.title).toContain('Опомена');
    expect(rows[0]!.title).not.toMatch(/ден\./);
    expect(rows[0]!.link).toBe('/portal/invoices');
  });

  it('an assembly invitation notifies the invited owners, and a later decision opens voting', async () => {
    const when = new Date(Date.now() + 40 * 24 * 3600 * 1000).toISOString();
    // `setupPublishedBuilding`'s units carry no `ownershipShare` (only `areaM2`, for billing), so the
    // default 'share' quorum basis would refuse to invite (plan addendum 3, `assemblyOwners`); the
    // notification trigger under test is indifferent to the quorum basis, so 'count' sidesteps it.
    const assembly = (await post(`/api/buildings/${A.buildingId}/assemblies`, { scheduledAt: when, location: 'Влез А', quorumBasis: 'count' })).json();
    expect((await post(`/api/assemblies/${assembly.id}/invite`)).statusCode).toBe(200);
    const invited = (await ownerRows()).filter((r) => r.kind === 'assembly_invited');
    expect(invited).toHaveLength(1);
    expect(invited[0]!.link).toBe(`/portal/assemblies/${assembly.id}`);

    expect((await post(`/api/assemblies/${assembly.id}/decisions`, { title: 'Нов пристапен систем' })).statusCode).toBe(201);
    const opened = (await ownerRows()).filter((r) => r.kind === 'assembly_voting_opened');
    expect(opened).toHaveLength(1);
    expect(opened[0]!.body).toContain('Нов пристапен систем');
  });

  it('a decision added to a draft assembly notifies nobody', async () => {
    const when = new Date(Date.now() + 40 * 24 * 3600 * 1000).toISOString();
    const draft = (await post(`/api/buildings/${A.buildingId}/assemblies`, { scheduledAt: when, location: 'Влез Б' })).json();
    const before = (await ownerRows()).filter((r) => r.kind === 'assembly_voting_opened').length;
    await post(`/api/assemblies/${draft.id}/decisions`, { title: 'Сеуште нацрт' });
    expect((await ownerRows()).filter((r) => r.kind === 'assembly_voting_opened')).toHaveLength(before);
  });

  it('a portal request rings the manager’s bell, and its status changes ring the owner’s', async () => {
    const created = await t.app.inject({
      method: 'POST', url: '/api/portal/maintenance', headers: { cookie: ownerCookie },
      payload: { contactId: A.owners.O1, buildingId: A.buildingId, unitId, title: 'Протекува цевка во визбата', description: 'Трет ден.', category: 'plumbing', priority: 'high' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const requestId = created.json().id;

    const staff = (await staffRows()).filter((r) => r.kind === 'maintenance_request_created');
    expect(staff).toHaveLength(1);
    expect(staff[0]!.body).toBe('Протекува цевка во визбата');
    expect(staff[0]!.link).toBe(`/app/buildings/${A.buildingId}?tab=maintenance`);

    expect((await post(`/api/maintenance-requests/${requestId}/status`, { status: 'triaged' })).statusCode).toBe(200);
    const owner = (await ownerRows()).filter((r) => r.kind === 'maintenance_status');
    expect(owner).toHaveLength(1);
    expect(owner[0]!.title).toBe('Одржување: Прегледано');
    expect(owner[0]!.link).toBe(`/portal/maintenance/${requestId}`);
  });

  it('a staff-created request notifies no owner: there is no owner behind it', async () => {
    const before = (await ownerRows()).filter((r) => r.kind === 'maintenance_status').length;
    const own = (await post(`/api/buildings/${A.buildingId}/maintenance`, { title: 'Фарбање на влез', category: 'common_area' })).json();
    await post(`/api/maintenance-requests/${own.id}/status`, { status: 'triaged' });
    expect((await ownerRows()).filter((r) => r.kind === 'maintenance_status')).toHaveLength(before);
  });
});
