import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Chromium is mocked exactly as in reminders.test.ts: the invitation send renders a PDF attachment
// and no test may depend on a browser being installed.
vi.mock('playwright-core', () => {
  const launch = vi.fn(async () => ({
    isConnected: () => true,
    newContext: async () => ({ newPage: async () => ({ setContent: async () => {}, pdf: async () => Buffer.from('%PDF-assembly') }), close: async () => {} }),
    close: async () => {},
  }));
  return { chromium: { launch } };
});

import { schema } from '@domar/db';
import { eq } from 'drizzle-orm';
import { hashPassword } from '../src/auth/password.js';
import { setupAssemblyBuilding } from './billing-fixture.js';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

interface Invitation { id: string; contactId: string; contactName: string; email: string | null; channel: string; status: string; sentAt: string | null; error: string | null }
interface Decision { id: string; title: string; text: string | null; sortOrder: number; result: string }
interface Assembly {
  id: string; buildingId: string; scheduledAt: string; location: string; status: string; quorumBasis: string;
  agenda: { id: string; title: string; text: string }[]; invitedAt: string | null; lateInvitation: boolean; lateReason: string | null;
  decisions: Decision[]; invitations: Invitation[]; decisionCount: number; invitationCount: number;
}

describe('assemblies', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let b: Awaited<ReturnType<typeof registerTenant>>;
  let A: Awaited<ReturnType<typeof setupAssemblyBuilding>>;
  let readonlyCookie = '';

  const post = (url: string, payload: Record<string, unknown> = {}, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? a.cookie }, payload });
  const get = (url: string, cookie?: string) => t.app.inject({ method: 'GET', url, headers: { cookie: cookie ?? a.cookie } });
  const patch = (url: string, payload: Record<string, unknown>, cookie?: string) =>
    t.app.inject({ method: 'PATCH', url, headers: { cookie: cookie ?? a.cookie }, payload });
  const del = (url: string, cookie?: string) => t.app.inject({ method: 'DELETE', url, headers: { cookie: cookie ?? a.cookie } });
  const events = async (buildingId: string) => (await get(`/api/buildings/${buildingId}/legal-events?pageSize=100`)).json().rows as { kind: string; refId: string | null; dueAt: string | null; evidence: Record<string, unknown> }[];
  const create = async (body: Record<string, unknown>): Promise<Assembly> => (await post(`/api/buildings/${A.buildingId}/assemblies`, body)).json();

  beforeAll(async () => {
    t = await createTestApp({ SMTP_URL: 'json' });
    a = await registerTenant(t.app, 'firma-sobir');
    b = await registerTenant(t.app, 'firma-sobir-other');
    A = await setupAssemblyBuilding(t.app, a.cookie, { A: 'ana@firma-sobir.mk', B: 'bogdan@firma-sobir.mk' });
    const passwordHash = await hashPassword('correct-horse-1');
    await t.db.insert(schema.users).values({ tenantId: a.tenantId, email: 'ro@firma-sobir.mk', passwordHash, firstName: 'R', lastName: 'O', role: 'readonly' });
    const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantSlug: 'firma-sobir', email: 'ro@firma-sobir.mk', password: 'correct-horse-1' } });
    const raw = login.headers['set-cookie'];
    readonlyCookie = String(Array.isArray(raw) ? raw[0] : raw).split(';')[0]!;
  });
  afterAll(async () => {
    const m = await import('../src/pdf/html-to-pdf.js');
    await m.closePdfBrowser();
    m._resetForTests();
    await t.close();
  });

  it('creates a draft with a numbered agenda and its decisions', async () => {
    const res = await post(`/api/buildings/${A.buildingId}/assemblies`, {
      scheduledAt: inDays(20), location: 'Влез А, приземје', quorumBasis: 'share',
      agenda: [{ title: 'Извештај за 2025' }, { title: 'Избор на управител', text: 'Предлог: продолжување на договорот' }],
      decisions: [{ title: 'Усвојување на извештајот' }, { title: 'Продолжување на договорот', text: 'За период од 2 години' }],
    });
    expect(res.statusCode).toBe(201);
    const body: Assembly = res.json();
    expect(body.status).toBe('draft');
    expect(body.quorumBasis).toBe('share');
    expect(body.location).toBe('Влез А, приземје');
    expect(body.agenda.map((x) => x.title)).toEqual(['Извештај за 2025', 'Избор на управител']);
    expect(body.agenda[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.agenda[0]!.text).toBe('');
    expect(body.decisions.map((d) => d.title)).toEqual(['Усвојување на извештајот', 'Продолжување на договорот']);
    expect(body.decisions.map((d) => d.sortOrder)).toEqual([0, 1]);
    expect(body.decisions.every((d) => d.result === 'pending')).toBe(true);
    expect(body.invitations).toEqual([]);
    expect(body.lateInvitation).toBe(false);
    // The list carries the counts without the children.
    const list = (await get(`/api/buildings/${A.buildingId}/assemblies`)).json();
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0].decisionCount).toBe(2);
    expect(list.rows[0].invitationCount).toBe(0);
    expect(list.rows[0].decisions).toBeUndefined();
  });

  it('edits the draft, adds, renames and removes a decision', async () => {
    const created = await create({ scheduledAt: inDays(30), agenda: [{ title: 'Точка 1' }] });
    const moved = (await patch(`/api/assemblies/${created.id}`, { location: 'Кај влез Б', agenda: [{ id: created.agenda[0]!.id, title: 'Точка 1 (изменета)' }, { title: 'Точка 2' }] })).json();
    expect(moved.location).toBe('Кај влез Б');
    expect(moved.agenda.map((x: { title: string }) => x.title)).toEqual(['Точка 1 (изменета)', 'Точка 2']);
    expect(moved.agenda[0].id).toBe(created.agenda[0]!.id);

    const withDecision: Assembly = (await post(`/api/assemblies/${created.id}/decisions`, { title: 'Одлука А' })).json();
    expect(withDecision.decisions.map((d) => d.title)).toEqual(['Одлука А']);
    const decisionId = withDecision.decisions[0]!.id;
    const renamed: Assembly = (await patch(`/api/assemblies/${created.id}/decisions/${decisionId}`, { title: 'Одлука А (изменета)', text: 'Образложение' })).json();
    expect(renamed.decisions[0]!.title).toBe('Одлука А (изменета)');
    expect(renamed.decisions[0]!.text).toBe('Образложение');
    expect((await del(`/api/assemblies/${created.id}/decisions/${decisionId}`)).statusCode).toBe(204);
    expect(((await get(`/api/assemblies/${created.id}`)).json() as Assembly).decisions).toEqual([]);
    expect((await del(`/api/assemblies/${created.id}`)).statusCode).toBe(204);
    expect((await get(`/api/assemblies/${created.id}`)).statusCode).toBe(404);
  });

  it('refuses an invitation fewer than fifteen days ahead, and takes one with a reason', async () => {
    const soon = await create({ scheduledAt: inDays(14), agenda: [{ title: 'Итна точка' }] });
    const refused = await post(`/api/assemblies/${soon.id}/invite`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('invitation_too_late');
    // Civil days in the tenant's zone: fourteen days out is fourteen, whatever the clock says.
    expect(refused.json().error.details).toEqual({ days: 14, minDays: 15 });
    // Still a draft: the claim rolled back with the throw.
    expect(((await get(`/api/assemblies/${soon.id}`)).json() as Assembly).status).toBe('draft');

    const ok = await post(`/api/assemblies/${soon.id}/invite`, { override: { reason: 'Итна санација на кров' } });
    expect(ok.statusCode).toBe(200);
    const body: Assembly = ok.json();
    expect(body.status).toBe('invited');
    expect(body.lateInvitation).toBe(true);
    expect(body.lateReason).toBe('Итна санација на кров');
    const invited = (await events(A.buildingId)).filter((e) => e.kind === 'assembly_invited' && e.refId === soon.id);
    expect(invited).toHaveLength(1);
    expect(invited[0]!.evidence.late).toBe(true);
    expect(invited[0]!.evidence.lateReason).toBe('Итна санација на кров');
    expect(invited[0]!.evidence.contacts).toBe(3);
    expect(invited[0]!.dueAt).toBe(soon.scheduledAt);
  });

  it('invites on time: email where there is an address, a pending letter where there is none', async () => {
    const before = t.app.mailer.outbox.length;
    const assembly = await create({
      scheduledAt: inDays(20), location: 'Влез А', quorumBasis: 'share',
      agenda: [{ title: 'Годишен извештај' }], decisions: [{ title: 'Усвојување' }],
    });
    const body: Assembly = (await post(`/api/assemblies/${assembly.id}/invite`)).json();
    expect(body.status).toBe('invited');
    expect(body.lateInvitation).toBe(false);
    expect(body.invitations).toHaveLength(3);
    const byContact = Object.fromEntries(body.invitations.map((i) => [i.contactId, i]));
    expect(byContact[A.owners.A]!.channel).toBe('email');
    expect(byContact[A.owners.A]!.status).toBe('sent');
    expect(byContact[A.owners.B]!.channel).toBe('email');
    expect(byContact[A.owners.C]!.channel).toBe('letter');
    expect(byContact[A.owners.C]!.status).toBe('pending');
    expect(byContact[A.owners.C]!.sentAt).toBeNull();

    // Two emails went out, both carrying the one invitation PDF.
    const sent = t.app.mailer.outbox.slice(before);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.subject).toBe('Покана за собир — Востаничка 7');
    expect(sent[0]!.text).toContain('Годишен извештај');
    expect(sent[0]!.text).toContain('член 37');
    expect(sent[0]!.attachments![0]!.content.subarray(0, 4).toString()).toBe('%PDF');
    expect(sent.map((m) => m.to).sort()).toEqual(['ana@firma-sobir.mk', 'bogdan@firma-sobir.mk']);

    // One event, with the channel split and no late flag.
    const invited = (await events(A.buildingId)).filter((e) => e.kind === 'assembly_invited' && e.refId === assembly.id);
    expect(invited).toHaveLength(1);
    expect(invited[0]!.evidence).toMatchObject({ assemblyId: assembly.id, contacts: 3, channels: { email: 2, letter: 1 }, late: false });
    expect(invited[0]!.evidence.lateReason).toBeUndefined();

    // A printed letter is evidence of delivery, and it writes no second legal event.
    const letter = byContact[A.owners.C]!;
    const printed: Assembly = (await post(`/api/assembly-invitations/${letter.id}/printed`)).json();
    expect(printed.invitations.find((i) => i.contactId === A.owners.C)!.status).toBe('printed');
    expect((await events(A.buildingId)).filter((e) => e.kind === 'assembly_invited' && e.refId === assembly.id)).toHaveLength(1);
    expect((await post(`/api/assembly-invitations/${letter.id}/printed`)).statusCode).toBe(409);

    // A second invitation is refused; the agenda and the decisions stay editable.
    expect((await post(`/api/assemblies/${assembly.id}/invite`)).statusCode).toBe(409);
    expect((await post(`/api/assemblies/${assembly.id}/decisions`, { title: 'Дополнителна одлука' })).statusCode).toBe(201);
    // The quorum basis is frozen once the invitations are out.
    const frozen = await patch(`/api/assemblies/${assembly.id}`, { quorumBasis: 'count' });
    expect(frozen.statusCode).toBe(409);
    expect(frozen.json().error.code).toBe('quorum_basis_locked');

    // The invitation document is readable as HTML and as a PDF.
    const html = await get(`/api/assemblies/${assembly.id}/invitation/html`);
    expect(html.statusCode).toBe(200);
    expect(html.body).toContain('Покана за собир на сопственици');
    expect(html.body).toContain('Годишен извештај');
    expect(html.body).toContain('Востаничка 7');
    const pdf = await get(`/api/assemblies/${assembly.id}/invitation/pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('cancels a called assembly, closes its undelivered invitations and refuses to call it again', async () => {
    const assembly = await create({ scheduledAt: inDays(25), agenda: [{ title: 'Точка' }] });
    const called: Assembly = (await post(`/api/assemblies/${assembly.id}/invite`)).json();
    const letter = called.invitations.find((i) => i.contactId === A.owners.C)!;
    expect(letter.status).toBe('pending');
    const cancelled: Assembly = (await post(`/api/assemblies/${assembly.id}/cancel`, { reason: 'Нема доволно интерес' })).json();
    expect(cancelled.status).toBe('cancelled');
    // The letter nobody printed is closed with the assembly; the two emails already out stay evidence.
    expect(cancelled.invitations.find((i) => i.contactId === A.owners.C)!.status).toBe('cancelled');
    expect(cancelled.invitations.filter((i) => i.status === 'sent')).toHaveLength(2);
    expect((await post(`/api/assembly-invitations/${letter.id}/printed`)).statusCode).toBe(409);
    // The notice of an assembly nobody will hold is no longer served.
    const html = await get(`/api/assemblies/${assembly.id}/invitation/html`);
    expect(html.statusCode).toBe(409);
    expect(html.json().error.code).toBe('not_invited');
    expect((await get(`/api/assemblies/${assembly.id}/invitation/pdf`)).statusCode).toBe(409);
    expect((await post(`/api/assemblies/${assembly.id}/invite`)).statusCode).toBe(409);
    expect((await post(`/api/assemblies/${assembly.id}/cancel`, { reason: 'Повторно' })).statusCode).toBe(409);
    expect((await del(`/api/assemblies/${assembly.id}`)).statusCode).toBe(409);
  });

  it('freezes the date, the place, the agenda and the ballot once the invitations are out', async () => {
    const assembly = await create({ scheduledAt: inDays(20), location: 'Влез А', agenda: [{ title: 'Точка' }] });
    const moved = inDays(21);
    // A draft is moved freely.
    expect((await patch(`/api/assemblies/${assembly.id}`, { scheduledAt: moved })).statusCode).toBe(200);
    expect((await post(`/api/assemblies/${assembly.id}/invite`)).statusCode).toBe(200);

    const refused = await patch(`/api/assemblies/${assembly.id}`, { scheduledAt: inDays(22) });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('schedule_locked');
    expect(refused.json().error.details).toEqual({ fields: ['scheduledAt'] });
    expect((await patch(`/api/assemblies/${assembly.id}`, { location: 'Влез Б' })).json().error.code).toBe('schedule_locked');
    expect((await patch(`/api/assemblies/${assembly.id}`, { agenda: [{ title: 'Друга точка' }] })).json().error.code).toBe('schedule_locked');
    // The owners were called to this date and this agenda, and that is what they still find.
    const after: Assembly = (await get(`/api/assemblies/${assembly.id}`)).json();
    expect(new Date(after.scheduledAt).toISOString()).toBe(new Date(moved).toISOString());
    expect(after.location).toBe('Влез А');
    expect(after.agenda.map((x) => x.title)).toEqual(['Точка']);
    // A decision can still be put on the ballot, but one already on it cannot be taken off.
    const withDecision: Assembly = (await post(`/api/assemblies/${assembly.id}/decisions`, { title: 'Одлука' })).json();
    const removed = await del(`/api/assemblies/${assembly.id}/decisions/${withDecision.decisions[0]!.id}`);
    expect(removed.statusCode).toBe(409);
    expect(removed.json().error.code).toBe('assembly_locked');
    expect((await patch(`/api/assemblies/${assembly.id}/decisions/${withDecision.decisions[0]!.id}`, { text: 'Образложение' })).statusCode).toBe(200);
  });

  it('keeps the invitation document readable once the assembly has been held', async () => {
    const assembly = await create({ scheduledAt: inDays(20), agenda: [{ title: 'Точка за одржан собир' }] });
    const called: Assembly = (await post(`/api/assemblies/${assembly.id}/invite`)).json();
    const letter = called.invitations.find((i) => i.contactId === A.owners.C)!;
    // `held` arrives with the hold endpoint in the next task; the flip stands in for it here.
    await t.db.update(schema.assemblies).set({ status: 'held' }).where(eq(schema.assemblies.id, assembly.id));
    const html = await get(`/api/assemblies/${assembly.id}/invitation/html`);
    expect(html.statusCode).toBe(200);
    expect(html.body).toContain('Точка за одржан собир');
    expect((await get(`/api/assemblies/${assembly.id}/invitation/pdf`)).statusCode).toBe(200);
    // Printing a letter after the meeting delivers nothing, so that stays refused.
    const printed = await post(`/api/assembly-invitations/${letter.id}/printed`);
    expect(printed.statusCode).toBe(409);
    expect(printed.json().error.code).toBe('not_invited');
  });

  it('lets only one of two simultaneous invitations through', async () => {
    const assembly = await create({ scheduledAt: inDays(30), agenda: [{ title: 'Точка' }] });
    const both = await Promise.all([post(`/api/assemblies/${assembly.id}/invite`), post(`/api/assemblies/${assembly.id}/invite`)]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    // One set of invitations, one legal event: the claim is what serialises the two clicks.
    const body: Assembly = (await get(`/api/assemblies/${assembly.id}`)).json();
    expect(body.invitations).toHaveLength(3);
    expect((await events(A.buildingId)).filter((e) => e.kind === 'assembly_invited' && e.refId === assembly.id)).toHaveLength(1);
  });

  it('refuses to invite a building with no owners, or an assembly already past', async () => {
    const empty = (await post('/api/buildings', { name: 'Празна 2' })).json().id;
    const none = (await post(`/api/buildings/${empty}/assemblies`, { scheduledAt: inDays(20) })).json();
    const res = await post(`/api/assemblies/${none.id}/invite`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('no_owners');
    // Still a draft: the claim rolled back with the throw.
    expect(((await get(`/api/assemblies/${none.id}`)).json() as Assembly).status).toBe('draft');
    // A date in the past is not something an override can buy.
    const past = await create({ scheduledAt: inDays(-2) });
    const late = await post(`/api/assemblies/${past.id}/invite`, { override: { reason: 'Сепак ја праќаме' } });
    expect(late.statusCode).toBe(400);
    expect(late.json().error.code).toBe('assembly_in_the_past');
  });

  it('invites the owner of two units once', async () => {
    const buildingId = (await post('/api/buildings', { name: 'Двоен сопственик 3' })).json().id;
    const owner = (await post('/api/contacts', { firstName: 'Двоен', lastName: 'Сопственик' })).json().id;
    for (const [label, share] of [['1', 0.6], ['2', 0.4]] as [string, number][]) {
      await post(`/api/buildings/${buildingId}/units`, { label, kind: 'apartment', areaM2: 40, ownershipShare: share, ownerContactId: owner });
    }
    const assembly = (await post(`/api/buildings/${buildingId}/assemblies`, { scheduledAt: inDays(20), quorumBasis: 'share' })).json();
    const body: Assembly = (await post(`/api/assemblies/${assembly.id}/invite`)).json();
    expect(body.invitations).toHaveLength(1);
    expect(body.invitations[0]!.contactId).toBe(owner);
    const invited = (await events(buildingId)).filter((e) => e.kind === 'assembly_invited');
    expect(invited[0]!.evidence).toMatchObject({ contacts: 1, channels: { email: 0, letter: 1 } });
  });

  it('refuses a share quorum while a unit has no ownership share', async () => {
    const noShares = (await post('/api/buildings', { name: 'Без удели 1' })).json().id;
    const owner = (await post('/api/contacts', { firstName: 'Без', lastName: 'Удел' })).json().id;
    await post(`/api/buildings/${noShares}/units`, { label: '1', kind: 'apartment', areaM2: 40, ownerContactId: owner });
    const assembly = (await post(`/api/buildings/${noShares}/assemblies`, { scheduledAt: inDays(20), quorumBasis: 'share' })).json();
    const res = await post(`/api/assemblies/${assembly.id}/invite`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('missing_ownership_shares');
    expect(res.json().error.details).toEqual({ units: ['1'] });
    // The same building with a `count` quorum invites fine.
    const counted = (await post(`/api/buildings/${noShares}/assemblies`, { scheduledAt: inDays(20), quorumBasis: 'count' })).json();
    expect((await post(`/api/assemblies/${counted.id}/invite`)).statusCode).toBe(200);
  });

  it('is invisible to another tenant and gated by role', async () => {
    const assembly = await create({ scheduledAt: inDays(40) });
    expect((await get(`/api/assemblies/${assembly.id}`, b.cookie)).statusCode).toBe(404);
    expect((await get(`/api/buildings/${A.buildingId}/assemblies`, b.cookie)).statusCode).toBe(404);
    expect((await patch(`/api/assemblies/${assembly.id}`, { location: 'x' }, b.cookie)).statusCode).toBe(404);
    expect((await post(`/api/assemblies/${assembly.id}/invite`, {}, b.cookie)).statusCode).toBe(404);
    // readonly reads everything and writes nothing (spec §10).
    expect((await get(`/api/buildings/${A.buildingId}/assemblies`, readonlyCookie)).statusCode).toBe(200);
    expect((await get(`/api/assemblies/${assembly.id}`, readonlyCookie)).statusCode).toBe(200);
    expect((await post(`/api/buildings/${A.buildingId}/assemblies`, { scheduledAt: inDays(40) }, readonlyCookie)).statusCode).toBe(403);
    expect((await post(`/api/assemblies/${assembly.id}/invite`, {}, readonlyCookie)).statusCode).toBe(403);
  });
});
