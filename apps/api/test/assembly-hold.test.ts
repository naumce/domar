import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The render is gated so one test can hold an assembly's transaction open while a ballot races it.
// `h.block` is null for every other test, and the mock then behaves like the one in assemblies.test.ts.
const h = vi.hoisted(() => ({ block: null as Promise<void> | null, reached: () => {} }));

vi.mock('playwright-core', () => {
  const launch = vi.fn(async () => ({
    isConnected: () => true,
    newContext: async () => ({
      newPage: async () => ({
        setContent: async () => {},
        pdf: async () => {
          if (h.block) { h.reached(); await h.block; }
          return Buffer.from('%PDF-minutes');
        },
      }),
      close: async () => {},
    }),
    close: async () => {},
  }));
  return { chromium: { launch } };
});

import { schema } from '@domar/db';
import { and, eq } from 'drizzle-orm';
import { hashPassword } from '../src/auth/password.js';
import { setupAssemblyBuilding } from './billing-fixture.js';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

const DAY = 86_400_000;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();
const delay = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

interface Decision {
  id: string; title: string; result: string; forWeight: number; againstWeight: number; abstainWeight: number;
  presentWeight: number; basisTotal: number; quorumReached: boolean;
}
interface Assembly {
  id: string; buildingId: string; scheduledAt: string; status: string; heldAt: string | null; quorumBasis: string;
  minutesDocumentId: string | null; decisions: Decision[];
  attendance: { contactId: string; present: boolean; proxyName: string | null; weightBp: number }[];
  votes: { decisionId: string; contactId: string; choice: string; via: string }[];
}

describe('assembly voting, hold and the portal', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let b: Awaited<ReturnType<typeof registerTenant>>;
  let A: Awaited<ReturnType<typeof setupAssemblyBuilding>>;
  let ownerCookie = '';
  let readonlyCookie = '';

  const post = (url: string, payload: Record<string, unknown> = {}, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? a.cookie }, payload });
  const get = (url: string, cookie?: string) => t.app.inject({ method: 'GET', url, headers: { cookie: cookie ?? a.cookie } });
  const owner = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
    t.app.inject({ method, url, headers: { cookie: ownerCookie }, ...(payload ? { payload } : {}) });
  const events = async (buildingId: string) => (await get(`/api/buildings/${buildingId}/legal-events?pageSize=100`)).json().rows as { kind: string; refId: string | null; occurredAt: string; evidence: Record<string, unknown> }[];
  const duty = async (buildingId: string, key: string) =>
    (await get(`/api/buildings/${buildingId}/compliance`)).json().duties.find((d: { key: string }) => d.key === key) as { status: string; count: number | null; lastEvidenceAt: string | null; flags: string[] };

  /**
   * A called assembly with `titles.length` decisions. Art. 37 needs fifteen civil days between the
   * notice and the meeting, and a meeting can only be minuted once it has happened, so the row is
   * wound back after the invitations go out instead of the suite waiting twenty days for it.
   */
  const called = async (buildingId: string, quorumBasis: 'share' | 'count', titles: string[], days = 20): Promise<Assembly> => {
    const created: Assembly = (await post(`/api/buildings/${buildingId}/assemblies`, {
      scheduledAt: inDays(days), location: 'Влез А', quorumBasis,
      agenda: [{ title: 'Дневен ред' }], decisions: titles.map((title) => ({ title })),
    })).json();
    await post(`/api/assemblies/${created.id}/invite`);
    await t.db.update(schema.assemblies)
      .set({ invitedAt: new Date(Date.now() - (days + 1) * DAY), scheduledAt: new Date(Date.now() - DAY) })
      .where(eq(schema.assemblies.id, created.id));
    return (await get(`/api/assemblies/${created.id}`)).json();
  };
  const paper = (id: string, decisionId: string, contactId: string, choice: string, cookie?: string) =>
    post(`/api/assemblies/${id}/decisions/${decisionId}/votes`, { contactId, choice }, cookie);

  beforeAll(async () => {
    t = await createTestApp({ SMTP_URL: 'json' });
    a = await registerTenant(t.app, 'firma-glas');
    b = await registerTenant(t.app, 'firma-glas-other');
    A = await setupAssemblyBuilding(t.app, a.cookie, { A: 'ana@firma-glas.mk', B: 'bogdan@firma-glas.mk' });
    const invite = (await post(`/api/contacts/${A.owners.A}/portal-invite`)).json();
    const registered = await t.app.inject({ method: 'POST', url: '/api/portal/register', payload: { code: invite.code, email: 'ana.owner@example.mk', password: 'correct-horse-1' } });
    expect(registered.statusCode).toBe(201);
    const raw = registered.headers['set-cookie'];
    ownerCookie = String(Array.isArray(raw) ? raw[0] : raw).split(';')[0]!;
    const passwordHash = await hashPassword('correct-horse-1');
    await t.db.insert(schema.users).values({ tenantId: a.tenantId, email: 'ro@firma-glas.mk', passwordHash, firstName: 'R', lastName: 'O', role: 'readonly' });
    const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantSlug: 'firma-glas', email: 'ro@firma-glas.mk', password: 'correct-horse-1' } });
    const rawRo = login.headers['set-cookie'];
    readonlyCookie = String(Array.isArray(rawRo) ? rawRo[0] : rawRo).split(';')[0]!;
  });
  afterAll(async () => {
    const m = await import('../src/pdf/html-to-pdf.js');
    await m.closePdfBrowser();
    m._resetForTests();
    await t.close();
  });

  it('lists the owners with their weights in basis points', async () => {
    const assembly = await called(A.buildingId, 'share', ['Одлука']);
    const body = (await get(`/api/assemblies/${assembly.id}/owners`)).json();
    expect(body.quorumBasis).toBe('share');
    expect(body.basisTotal).toBe(10000);
    expect(Object.fromEntries(body.rows.map((r: { contactId: string; weightBp: number }) => [r.contactId, r.weightBp]))).toEqual({
      [A.owners.A]: 5000, [A.owners.B]: 3000, [A.owners.C]: 2000,
    });
  });

  it('weighs one owner as one vote under a count quorum', async () => {
    const assembly = await called(A.buildingId, 'count', ['Одлука']);
    const body = (await get(`/api/assemblies/${assembly.id}/owners`)).json();
    expect(body.quorumBasis).toBe('count');
    expect(body.basisTotal).toBe(3);
    expect(body.rows.map((r: { weightBp: number }) => r.weightBp)).toEqual([1, 1, 1]);
    await post(`/api/assemblies/${assembly.id}/cancel`, { reason: 'Тест' });
  });

  it('tallies a share quorum with the weights of the owners who took part', async () => {
    const assembly = await called(A.buildingId, 'share', ['Усвојување на извештајот', 'Продолжување на договорот', 'Нова фасада']);
    const [d1, d2, d3] = assembly.decisions;
    await paper(assembly.id, d1!.id, A.owners.A, 'for');
    await paper(assembly.id, d1!.id, A.owners.B, 'against');
    await paper(assembly.id, d2!.id, A.owners.A, 'against');
    await paper(assembly.id, d2!.id, A.owners.B, 'for');
    await paper(assembly.id, d3!.id, A.owners.A, 'abstain');
    await paper(assembly.id, d3!.id, A.owners.B, 'for');

    // No attendance sheet at all: casting a vote is participating (plan addendum 7).
    const held: Assembly = (await post(`/api/assemblies/${assembly.id}/hold`, { attendance: [] })).json();
    expect(held.status).toBe('held');
    expect(held.heldAt).toBe(assembly.scheduledAt);
    expect(held.minutesDocumentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.fromEntries(held.attendance.map((r) => [r.contactId, r.present]))).toEqual({
      [A.owners.A]: true, [A.owners.B]: true, [A.owners.C]: false,
    });
    const byTitle = Object.fromEntries(held.decisions.map((d) => [d.title, d]));
    expect(byTitle['Усвојување на извештајот']).toMatchObject({ forWeight: 5000, againstWeight: 3000, abstainWeight: 0, presentWeight: 8000, basisTotal: 10000, quorumReached: true, result: 'passed' });
    expect(byTitle['Продолжување на договорот']).toMatchObject({ forWeight: 3000, againstWeight: 5000, result: 'rejected' });
    expect(byTitle['Нова фасада']).toMatchObject({ forWeight: 3000, againstWeight: 0, abstainWeight: 5000, result: 'passed' });

    const ev = (await events(A.buildingId)).find((e) => e.kind === 'assembly_held' && e.refId === assembly.id)!;
    expect(ev.evidence).toMatchObject({
      assemblyId: assembly.id, heldAt: assembly.scheduledAt, quorumReached: true,
      present: 8000, basisTotal: 10000, quorumBasis: 'share', discardedVotes: 0, minutesDocumentId: held.minutesDocumentId,
    });
    expect((ev.evidence.decisions as { id: string; result: string }[]).map((d) => d.result)).toEqual(['passed', 'rejected', 'passed']);

    // The minutes are a real, downloadable document of kind `minutes`.
    const doc = (await get(`/api/documents/${held.minutesDocumentId}`)).json();
    expect(doc.kind).toBe('minutes');
    expect(doc.buildingId).toBe(A.buildingId);
    expect(doc.mime).toBe('application/pdf');
    // The storage key never travels, not even on the route that creates the document.
    expect(doc.storageKey).toBeUndefined();
    const file = await get(`/api/documents/${held.minutesDocumentId}/download`);
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.subarray(0, 4).toString()).toBe('%PDF');

    // `held` is terminal.
    expect((await post(`/api/assemblies/${assembly.id}/hold`, { attendance: [] })).statusCode).toBe(409);
    expect((await post(`/api/assemblies/${assembly.id}/cancel`, { reason: 'Предомислување' })).statusCode).toBe(409);
    expect((await paper(assembly.id, held.decisions[0]!.id, A.owners.C, 'for')).statusCode).toBe(409);
  });

  it('turns the same two votes into a rejection under a count quorum', async () => {
    const assembly = await called(A.buildingId, 'count', ['Иста одлука']);
    const decisionId = assembly.decisions[0]!.id;
    await paper(assembly.id, decisionId, A.owners.A, 'for');
    await paper(assembly.id, decisionId, A.owners.B, 'against');
    const held: Assembly = (await post(`/api/assemblies/${assembly.id}/hold`, { attendance: [] })).json();
    expect(held.decisions[0]).toMatchObject({ forWeight: 1, againstWeight: 1, presentWeight: 2, basisTotal: 3, quorumReached: true, result: 'rejected' });
    expect(held.attendance.find((r) => r.contactId === A.owners.A)!.weightBp).toBe(1);
  });

  it('does not reach a quorum on exactly half the building', async () => {
    const assembly = await called(A.buildingId, 'share', ['Сама одлука']);
    await paper(assembly.id, assembly.decisions[0]!.id, A.owners.A, 'for');
    const held: Assembly = (await post(`/api/assemblies/${assembly.id}/hold`, { attendance: [] })).json();
    expect(held.decisions[0]).toMatchObject({ forWeight: 5000, presentWeight: 5000, basisTotal: 10000, quorumReached: false, result: 'no_quorum' });
    const ev = (await events(A.buildingId)).find((e) => e.kind === 'assembly_held' && e.refId === assembly.id)!;
    expect(ev.evidence.quorumReached).toBe(false);
  });

  it('refuses an attendance sheet naming somebody who owns nothing here', async () => {
    const assembly = await called(A.buildingId, 'share', ['Одлука']);
    const stranger = (await post('/api/contacts', { firstName: 'Туѓ', lastName: 'Човек' })).json().id;
    const res = await post(`/api/assemblies/${assembly.id}/hold`, { attendance: [{ contactId: stranger, present: true }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_reference');
    // The same stranger cannot be given a paper ballot either.
    const ballot = await paper(assembly.id, assembly.decisions[0]!.id, stranger, 'for');
    expect(ballot.statusCode).toBe(400);
    expect(ballot.json().error.code).toBe('invalid_reference');
    expect(((await get(`/api/assemblies/${assembly.id}`)).json() as Assembly).status).toBe('invited');
    await post(`/api/assemblies/${assembly.id}/cancel`, { reason: 'Тест' });
  });

  it('refuses a meeting dated in the future or before its own invitation', async () => {
    const assembly = await called(A.buildingId, 'share', ['Одлука']);
    const future = await post(`/api/assemblies/${assembly.id}/hold`, { heldAt: inDays(1), attendance: [] });
    expect(future.statusCode).toBe(400);
    expect(future.json().error.code).toBe('held_in_the_future');
    const early = await post(`/api/assemblies/${assembly.id}/hold`, { heldAt: inDays(-40), attendance: [] });
    expect(early.statusCode).toBe(400);
    expect(early.json().error.code).toBe('held_before_invited');
    expect(((await get(`/api/assemblies/${assembly.id}`)).json() as Assembly).status).toBe('invited');
    await post(`/api/assemblies/${assembly.id}/cancel`, { reason: 'Тест' });
  });

  it('lets a readonly user read the owners but neither vote nor close the meeting', async () => {
    const assembly = await called(A.buildingId, 'share', ['Одлука']);
    expect((await get(`/api/assemblies/${assembly.id}/owners`, readonlyCookie)).statusCode).toBe(200);
    expect((await paper(assembly.id, assembly.decisions[0]!.id, A.owners.A, 'for', readonlyCookie)).statusCode).toBe(403);
    expect((await post(`/api/assemblies/${assembly.id}/hold`, { attendance: [] }, readonlyCookie)).statusCode).toBe(403);
    await post(`/api/assemblies/${assembly.id}/cancel`, { reason: 'Тест' });
  });

  /**
   * The ballot must not slip between the hold's vote query and its commit: it would be stored and
   * never counted. The minutes render is blocked mid-transaction to make that window wide enough
   * to aim at; with the row lock in place the vote waits for the commit and is then refused.
   */
  it('makes a ballot cast during a hold wait for it, and then refuses it', async () => {
    const assembly = await called(A.buildingId, 'share', ['Одлука во лет']);
    const decisionId = assembly.decisions[0]!.id;
    await paper(assembly.id, decisionId, A.owners.A, 'for');
    await paper(assembly.id, decisionId, A.owners.C, 'for');

    let open = () => {};
    const reached = new Promise<void>((resolve) => { h.reached = resolve; });
    h.block = new Promise<void>((resolve) => { open = resolve; });
    const holding = post(`/api/assemblies/${assembly.id}/hold`, { attendance: [] });
    await reached; // the hold has claimed the row and is inside its transaction
    const voting = paper(assembly.id, decisionId, A.owners.B, 'against');
    await delay(200); // long enough for an unserialised vote to have committed
    h.block = null;
    open();
    const [heldRes, voteRes] = await Promise.all([holding, voting]);

    expect(heldRes.statusCode).toBe(200);
    expect(voteRes.statusCode).toBe(409);
    expect(voteRes.json().error.code).toBe('voting_closed');
    const held: Assembly = heldRes.json();
    expect(held.decisions[0]).toMatchObject({ forWeight: 7000, againstWeight: 0, presentWeight: 7000, basisTotal: 10000, quorumReached: true, result: 'passed' });
    // The refused ballot left no row behind at all.
    expect(((await get(`/api/assemblies/${assembly.id}`)).json() as Assembly).votes).toHaveLength(2);
  });

  it('keeps a ballot from somebody who has since sold out of the tally and names it in the minutes', async () => {
    const X = await setupAssemblyBuilding(t.app, a.cookie);
    const assembly = await called(X.buildingId, 'share', ['Одлука на соседната зграда']);
    const decisionId = assembly.decisions[0]!.id;
    await paper(assembly.id, decisionId, X.owners.A, 'for');
    await paper(assembly.id, decisionId, X.owners.B, 'for');
    await paper(assembly.id, decisionId, X.owners.C, 'against');
    // C sells to B before the meeting: the ballot stays on file and decides nothing.
    await t.db.update(schema.units).set({ ownerContactId: X.owners.B })
      .where(and(eq(schema.units.buildingId, X.buildingId), eq(schema.units.ownerContactId, X.owners.C)));

    const held: Assembly = (await post(`/api/assemblies/${assembly.id}/hold`, { attendance: [] })).json();
    expect(held.decisions[0]).toMatchObject({ forWeight: 10000, againstWeight: 0, presentWeight: 10000, basisTotal: 10000, quorumReached: true, result: 'passed' });
    expect(held.attendance.map((r) => r.contactId)).not.toContain(X.owners.C);
    expect(held.votes).toHaveLength(3); // the ballot is not erased, only uncounted
    const ev = (await events(X.buildingId)).find((e) => e.kind === 'assembly_held' && e.refId === assembly.id)!;
    expect(ev.evidence.discardedVotes).toBe(1);
    const [row] = await t.db.select({ minutesHtml: schema.assemblies.minutesHtml }).from(schema.assemblies)
      .where(eq(schema.assemblies.id, assembly.id));
    expect(row!.minutesHtml).toContain('Не се земени предвид');
    expect(row!.minutesHtml).toContain('Цветков');
  });

  it('lets a linked owner read, vote, change their mind, and read the result afterwards', async () => {
    const assembly = await called(A.buildingId, 'share', ['Портал одлука']);
    const decisionId = assembly.decisions[0]!.id;

    const list = (await owner('GET', `/api/portal/assemblies?contactId=${A.owners.A}`)).json();
    const row = list.rows.find((r: { id: string }) => r.id === assembly.id);
    expect(row).toBeDefined();
    expect(row.buildingName).toBe('Востаничка 7');
    expect(row.status).toBe('invited');

    let detail = (await owner('GET', `/api/portal/assemblies/${assembly.id}?contactId=${A.owners.A}`)).json();
    expect(detail.votingOpen).toBe(true);
    expect(detail.agenda.map((x: { title: string }) => x.title)).toEqual(['Дневен ред']);
    expect(detail.decisions[0].myChoice).toBeNull();
    // Nothing about the running tally leaks while the ballot is open (plan addendum 17).
    expect(detail.decisions[0].forWeight).toBeNull();
    expect(detail.decisions[0].result).toBeNull();

    // The notice the owner was summoned with is a PDF they can open for themselves.
    const invitationPdf = await owner('GET', `/api/portal/assemblies/${assembly.id}/invitation/pdf?contactId=${A.owners.A}`);
    expect(invitationPdf.statusCode).toBe(200);
    expect(invitationPdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');

    detail = (await owner('POST', `/api/portal/assemblies/${assembly.id}/decisions/${decisionId}/vote`, { contactId: A.owners.A, choice: 'against' })).json();
    expect(detail.decisions[0].myChoice).toBe('against');
    detail = (await owner('POST', `/api/portal/assemblies/${assembly.id}/decisions/${decisionId}/vote`, { contactId: A.owners.A, choice: 'for' })).json();
    expect(detail.decisions[0].myChoice).toBe('for');
    // One row, not two: the unique index plus the upsert.
    expect(((await get(`/api/assemblies/${assembly.id}`)).json() as Assembly).votes.filter((v) => v.contactId === A.owners.A)).toHaveLength(1);
    expect(((await get(`/api/assemblies/${assembly.id}`)).json() as Assembly).votes[0]!.via).toBe('portal');

    const held: Assembly = (await post(`/api/assemblies/${assembly.id}/hold`, {
      attendance: [{ contactId: A.owners.B, present: true, proxyName: 'Ана Анастасова' }],
    })).json();
    expect(held.decisions[0]).toMatchObject({ forWeight: 5000, againstWeight: 0, presentWeight: 8000, quorumReached: true, result: 'passed' });
    expect(held.attendance.find((r) => r.contactId === A.owners.B)!.proxyName).toBe('Ана Анастасова');

    detail = (await owner('GET', `/api/portal/assemblies/${assembly.id}?contactId=${A.owners.A}`)).json();
    expect(detail.votingOpen).toBe(false);
    expect(detail.status).toBe('held');
    expect(detail.decisions[0].forWeight).toBe(5000);
    expect(detail.decisions[0].result).toBe('passed');
    expect(detail.minutesDocumentId).toBe(held.minutesDocumentId);

    const closed = await owner('POST', `/api/portal/assemblies/${assembly.id}/decisions/${decisionId}/vote`, { contactId: A.owners.A, choice: 'against' });
    expect(closed.statusCode).toBe(409);
    expect(closed.json().error.code).toBe('voting_closed');

    // The minutes reach the owner through the document route that already checks the link.
    const docs = (await owner('GET', `/api/portal/documents?contactId=${A.owners.A}&buildingId=${A.buildingId}`)).json();
    expect(docs.rows.some((d: { id: string }) => d.id === held.minutesDocumentId)).toBe(true);
    const file = await owner('GET', `/api/portal/documents/${held.minutesDocumentId}/download?contactId=${A.owners.A}`);
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('is invisible across tenants and to an owner with no link to the contact', async () => {
    const assembly = await called(A.buildingId, 'share', ['Одлука']);
    expect((await post(`/api/assemblies/${assembly.id}/hold`, { attendance: [] }, b.cookie)).statusCode).toBe(404);
    expect((await get(`/api/assemblies/${assembly.id}/owners`, b.cookie)).statusCode).toBe(404);
    // The owner is linked to contact A only; asking as contact B is a 404, never a 403 (spec §19.6).
    expect((await owner('GET', `/api/portal/assemblies?contactId=${A.owners.B}`)).statusCode).toBe(404);
    expect((await owner('GET', `/api/portal/assemblies/${assembly.id}?contactId=${A.owners.B}`)).statusCode).toBe(404);
    expect((await owner('POST', `/api/portal/assemblies/${assembly.id}/decisions/${assembly.decisions[0]!.id}/vote`, { contactId: A.owners.B, choice: 'for' })).statusCode).toBe(404);
    // A manager session never reaches the portal routes.
    expect((await get(`/api/portal/assemblies?contactId=${A.owners.A}`)).statusCode).toBe(401);
    await post(`/api/assemblies/${assembly.id}/cancel`, { reason: 'Тест' });
  });

  it('feeds the Art. 37 compliance card from the assemblies table', async () => {
    const d = await duty(A.buildingId, 'assembly');
    expect(d.status).toBe('ok');
    expect(d.count).toBeGreaterThanOrEqual(4);
    expect(d.flags).toEqual([]);
    expect(d.lastEvidenceAt).not.toBeNull();

    // A second building, invited nine days ahead with a reason: the card keeps the Art. 37 flag.
    const late = await setupAssemblyBuilding(t.app, a.cookie);
    const created = (await post(`/api/buildings/${late.buildingId}/assemblies`, { scheduledAt: inDays(10), quorumBasis: 'share', decisions: [{ title: 'Итна одлука' }] })).json();
    await post(`/api/assemblies/${created.id}/invite`, { override: { reason: 'Итен дефект' } });
    // Before it is held the duty is `due`: the owners have been summoned and it has not happened yet.
    expect((await duty(late.buildingId, 'assembly')).status).toBe('due');
    // It ran early, so the day it ran is said explicitly; the invitation is still nine days short.
    await post(`/api/assemblies/${created.id}/hold`, {
      heldAt: new Date().toISOString(),
      attendance: [{ contactId: late.owners.A, present: true }, { contactId: late.owners.B, present: true }],
    });
    const flagged = await duty(late.buildingId, 'assembly');
    expect(flagged.flags).toEqual(['late_invitation']);
    expect(flagged.status).toBe('due');

    // A cancelled assembly is not counted at all.
    const third = await setupAssemblyBuilding(t.app, a.cookie);
    const scrapped = (await post(`/api/buildings/${third.buildingId}/assemblies`, { scheduledAt: inDays(30) })).json();
    await post(`/api/assemblies/${scrapped.id}/cancel`, { reason: 'Откажано' });
    expect((await duty(third.buildingId, 'assembly')).status).toBe('n/a');

    // Neither is a draft: nobody has been summoned to it yet.
    const drafted = await setupAssemblyBuilding(t.app, a.cookie);
    await post(`/api/buildings/${drafted.buildingId}/assemblies`, { scheduledAt: inDays(30) });
    expect((await duty(drafted.buildingId, 'assembly')).status).toBe('n/a');
  });
});
