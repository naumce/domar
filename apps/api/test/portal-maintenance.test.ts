import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupPublishedBuilding } from './billing-fixture.js';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1');

function multipart(fields: Record<string, string>, file: { filename: string; mime: string; content: Buffer }) {
  const boundary = `----domar${Math.random().toString(36).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.mime}\r\n\r\n`, 'utf8'));
  parts.push(file.content, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('portal maintenance', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let b: Awaited<ReturnType<typeof registerTenant>>;
  let A: Awaited<ReturnType<typeof setupPublishedBuilding>>;
  let B: Awaited<ReturnType<typeof setupPublishedBuilding>>;
  let ownerCookie = '';
  let neighbourCookie = '';
  let strangerCookie = '';
  let unitId = '';
  let requestId = '';

  const staffPost = (url: string, payload: Record<string, unknown> = {}, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? a.cookie }, payload });
  const staffGet = (url: string) => t.app.inject({ method: 'GET', url, headers: { cookie: a.cookie } });
  const portalGet = (url: string, cookie?: string) => t.app.inject({ method: 'GET', url, headers: { cookie: cookie ?? ownerCookie } });
  const portalPost = (url: string, payload: Record<string, unknown>, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? ownerCookie }, payload });
  const registerOwner = async (contactId: string, email: string, staffCookie: string) => {
    const code = (await staffPost(`/api/contacts/${contactId}/portal-invite`, {}, staffCookie)).json().code;
    const res = await t.app.inject({ method: 'POST', url: '/api/portal/register', payload: { code, email, password: 'correct-horse-1' } });
    expect(res.statusCode, res.body).toBe(201);
    return String(res.headers['set-cookie']).split(';')[0]!;
  };

  beforeAll(async () => {
    t = await createTestApp({ SMTP_URL: 'json' });
    a = await registerTenant(t.app, 'firma-pm');
    b = await registerTenant(t.app, 'firma-pm2');
    A = await setupPublishedBuilding(t.app, a.cookie);
    B = await setupPublishedBuilding(t.app, b.cookie);
    unitId = (await staffGet(`/api/buildings/${A.buildingId}/units`)).json().rows.find((u: { label: string }) => u.label === '1').id;
    ownerCookie = await registerOwner(A.owners.O1, 'o1@owner.mk', a.cookie);
    neighbourCookie = await registerOwner(A.owners.O2, 'o2@owner.mk', a.cookie);
    strangerCookie = await registerOwner(B.owners.O1, 'b1@owner.mk', b.cookie);
  });
  afterAll(async () => { await t.close(); });

  it('an owner reports a problem in their own building', async () => {
    const res = await portalPost('/api/portal/maintenance', {
      contactId: A.owners.O1, buildingId: A.buildingId, unitId,
      title: 'Протекува цевка во визбата', description: 'Вода тече покрај вертикалата под влезот.',
      category: 'plumbing', priority: 'high',
    });
    expect(res.statusCode, res.body).toBe(201);
    requestId = res.json().id;
    expect(res.json()).toMatchObject({
      status: 'new', category: 'plumbing', priority: 'high',
      buildingName: 'Партизанска 12', unitLabel: '1', photoCount: 0,
    });
    // The owner is the reporter, on the manager's board too.
    const board = (await staffGet(`/api/buildings/${A.buildingId}/maintenance`)).json().rows;
    expect(board[0]).toMatchObject({ id: requestId, reporterKind: 'owner', reporterName: 'Тест Анѓеловски' });
  });

  it('refuses a building the owner has no unit in, and another tenant’s building, both with 404', async () => {
    const body = { contactId: A.owners.O1, buildingId: B.buildingId, title: 'т', description: '', category: 'other', priority: 'normal' };
    expect((await portalPost('/api/portal/maintenance', body)).statusCode).toBe(404);
    // A contact id the caller holds no link to is a 404 before a tenant is ever resolved.
    expect((await portalPost('/api/portal/maintenance', { ...body, contactId: B.owners.O1, buildingId: B.buildingId })).statusCode).toBe(404);
  });

  it('refuses a unit somebody else owns', async () => {
    const otherUnit = (await staffGet(`/api/buildings/${A.buildingId}/units`)).json().rows.find((u: { label: string }) => u.label === '2').id;
    const res = await portalPost('/api/portal/maintenance', {
      contactId: A.owners.O1, buildingId: A.buildingId, unitId: otherUnit,
      title: 'т', description: '', category: 'other', priority: 'normal',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_reference');
  });

  it('lists the owner’s own requests and nobody else’s', async () => {
    const mine = (await portalGet(`/api/portal/maintenance?contactId=${A.owners.O1}`)).json();
    expect(mine.rows.map((r: { id: string }) => r.id)).toEqual([requestId]);
    expect(mine.total).toBe(1);
    const neighbour = (await portalGet(`/api/portal/maintenance?contactId=${A.owners.O2}`, neighbourCookie)).json();
    expect(neighbour.rows).toEqual([]);
    expect(neighbour.total).toBe(0);
    expect((await portalGet(`/api/portal/maintenance/${requestId}?contactId=${A.owners.O2}`, neighbourCookie)).statusCode).toBe(404);
    expect((await portalGet(`/api/portal/maintenance/${requestId}?contactId=${B.owners.O1}`, strangerCookie)).statusCode).toBe(404);
  });

  it('shows the owner only the owner-visible half of the feed', async () => {
    await staffPost(`/api/maintenance-requests/${requestId}/events`, { note: 'Домаќинот не се јавува, пробај попладне.', visibility: 'internal' });
    await staffPost(`/api/maintenance-requests/${requestId}/status`, { status: 'triaged', note: 'Примено, доаѓаме утре.', visibility: 'owner' });

    const detail = (await portalGet(`/api/portal/maintenance/${requestId}?contactId=${A.owners.O1}`)).json();
    expect(detail.status).toBe('triaged');
    const notes = detail.events.map((e: { note: string }) => e.note);
    expect(notes).toContain('Примено, доаѓаме утре.');
    expect(notes).not.toContain('Домаќинот не се јавува, пробај попладне.');
    // The internal note is not merely unrendered: the field it hid behind never reaches the wire.
    expect(JSON.stringify(detail)).not.toContain('visibility');
    expect(detail.events[0]).toMatchObject({ kind: 'created', authorKind: 'owner', authorName: 'Тест Анѓеловски' });
  });

  it('lets the owner add a note, always visible to themselves and to the manager', async () => {
    const res = await portalPost(`/api/portal/maintenance/${requestId}/events`, { contactId: A.owners.O1, note: 'Стана полошо, водата стигна до визбата.' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().events.at(-1)).toMatchObject({ note: 'Стана полошо, водата стигна до визбата.', authorKind: 'owner' });
    const staff = (await staffGet(`/api/maintenance-requests/${requestId}`)).json();
    expect(staff.events.at(-1)).toMatchObject({ visibility: 'owner', authorKind: 'owner', authorName: 'Тест Анѓеловски' });
  });

  it('accepts the owner’s photo and serves it back to them, but not to a neighbour', async () => {
    const m = multipart({ contactId: A.owners.O1 }, { filename: 'voda.png', mime: 'image/png', content: PNG });
    const res = await t.app.inject({ method: 'POST', url: `/api/portal/maintenance/${requestId}/photos`, headers: { cookie: ownerCookie, ...m.headers }, payload: m.payload });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().photos).toHaveLength(1);
    const documentId = res.json().photos[0].documentId;

    const file = await portalGet(`/api/portal/maintenance/${requestId}/photos/${documentId}?contactId=${A.owners.O1}`);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(Buffer.from(file.rawPayload).equals(PNG)).toBe(true);
    expect((await portalGet(`/api/portal/maintenance/${requestId}/photos/${documentId}?contactId=${A.owners.O2}`, neighbourCookie)).statusCode).toBe(404);

    // The manager sees it on the board, attributed to the owner.
    const staff = (await staffGet(`/api/maintenance-requests/${requestId}`)).json();
    expect(staff.photos[0]).toMatchObject({ documentId, uploadedByName: 'Тест Анѓеловски' });
  });

  it('refuses a photo on a request the owner did not report, and a file that is not a photo', async () => {
    const m = multipart({ contactId: A.owners.O2 }, { filename: 'tugo.png', mime: 'image/png', content: PNG });
    const theirs = await t.app.inject({ method: 'POST', url: `/api/portal/maintenance/${requestId}/photos`, headers: { cookie: neighbourCookie, ...m.headers }, payload: m.payload });
    expect(theirs.statusCode).toBe(404);

    const p = multipart({ contactId: A.owners.O1 }, { filename: 'racun.pdf', mime: 'application/pdf', content: PDF });
    const wrong = await t.app.inject({ method: 'POST', url: `/api/portal/maintenance/${requestId}/photos`, headers: { cookie: ownerCookie, ...p.headers }, payload: p.payload });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('unsupported_media_type');
    // Neither attempt left anything behind.
    expect((await portalGet(`/api/portal/maintenance/${requestId}?contactId=${A.owners.O1}`)).json().photos).toHaveLength(1);
  });

  it('gives the owner no way to change a status', async () => {
    const res = await portalPost(`/api/portal/maintenance/${requestId}/status`, { contactId: A.owners.O1, status: 'done' });
    expect(res.statusCode).toBe(404); // no such route at all
    const staffOnly = await t.app.inject({ method: 'POST', url: `/api/maintenance-requests/${requestId}/status`, headers: { cookie: ownerCookie }, payload: { status: 'done', cost: null } });
    expect(staffOnly.statusCode).toBe(401); // an owner cookie is not a staff session
  });

  it('shows the owner the closed request with the manager’s note', async () => {
    await staffPost(`/api/maintenance-requests/${requestId}/assign`, { assigneeUserId: a.userId });
    await staffPost(`/api/maintenance-requests/${requestId}/status`, { status: 'in_progress' });
    await staffPost(`/api/maintenance-requests/${requestId}/status`, {
      status: 'done', note: 'Заменета спојка, дефектот е отстранет.', visibility: 'owner',
      cost: { fund: 'reserve', costMinor: 1_200_000 },
    });
    const detail = (await portalGet(`/api/portal/maintenance/${requestId}?contactId=${A.owners.O1}`)).json();
    expect(detail.status).toBe('done');
    expect(detail.closedAt).not.toBeNull();
    expect(detail.events.at(-1).note).toBe('Заменета спојка, дефектот е отстранет.');
    // The money is the manager's business: the portal row carries no cost at all.
    expect(JSON.stringify(detail)).not.toContain('costMinor');
    // …but the fund page shows the expense, described in Macedonian (spec §45(4), addendum 14).
    const fund = (await portalGet(`/api/portal/buildings/${A.buildingId}/fund?contactId=${A.owners.O1}`)).json();
    expect(fund.transactions[0]).toMatchObject({ kind: 'expense', fund: 'reserve', amountMinor: -1_200_000 });
    expect(fund.transactions[0].description).toBe('Одржување: Водовод и канализација — Протекува цевка во визбата');
  });

  it('gives the owner the same answer on a closed request as the board gives the manager', async () => {
    const res = await portalPost(`/api/portal/maintenance/${requestId}/events`, { contactId: A.owners.O1, note: 'Фала, се е во ред.' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('status_locked');
  });
});
