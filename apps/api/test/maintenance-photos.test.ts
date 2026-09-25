import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupPublishedBuilding } from './billing-fixture.js';
import { createStaffUser, registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

/** A real 1×1 PNG: the store hashes whatever it gets, and a real one keeps the fixture honest. */
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

describe('maintenance photos and the cost of a closed request', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let A: Awaited<ReturnType<typeof setupPublishedBuilding>>;
  let tech: { id: string; cookie: string };
  let supplierId = '';

  const post = (url: string, payload: unknown, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? a.cookie }, payload: payload as never });
  const get = (url: string, cookie?: string) => t.app.inject({ method: 'GET', url, headers: { cookie: cookie ?? a.cookie } });
  const upload = (id: string, file: { filename: string; mime: string; content: Buffer }, cookie?: string) => {
    const m = multipart({ title: 'Фотографија од дефектот' }, file);
    return t.app.inject({ method: 'POST', url: `/api/maintenance-requests/${id}/photos`, headers: { cookie: cookie ?? a.cookie, ...m.headers }, payload: m.payload });
  };
  const create = async () => (await post(`/api/buildings/${A.buildingId}/maintenance`, {
    title: 'Протекува цевка во визбата', description: 'Вода тече покрај вертикалата.', category: 'plumbing', priority: 'high',
  })).json();

  beforeAll(async () => {
    t = await createTestApp();
    a = await registerTenant(t.app, 'firma-foto');
    A = await setupPublishedBuilding(t.app, a.cookie);
    tech = await createStaffUser(t.app, a.cookie, 'firma-foto', { email: 'stefan@firma-foto.mk', firstName: 'Стефан', lastName: 'Стефановски', role: 'technician' });
    supplierId = (await post('/api/suppliers', { name: 'Водовод Инженеринг ДООЕЛ' })).json().id;
  });
  afterAll(async () => { await t.close(); });

  it('stores a photo as a document of kind photo, linked to the request', async () => {
    const row = await create();
    const res = await upload(row.id, { filename: 'defekt.png', mime: 'image/png', content: PNG });
    expect(res.statusCode, res.body).toBe(201);
    const photos = res.json().photos;
    expect(photos).toHaveLength(1);
    expect(photos[0].fileName).toBe('defekt.png');
    expect(photos[0].mime).toBe('image/png');
    expect(photos[0].sizeBytes).toBe(PNG.length);
    expect(photos[0].uploadedByName).toBe('O firma-foto');
    expect(res.json().photoCount).toBe(1);

    const doc = (await get(`/api/documents/${photos[0].documentId}`)).json();
    expect(doc.kind).toBe('photo');
    expect(doc.buildingId).toBe(A.buildingId);
    const download = await get(`/api/documents/${photos[0].documentId}/download`);
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toBe('image/png');
    expect(Buffer.from(download.rawPayload).equals(PNG)).toBe(true);
    // The gallery's own route hands the owner the same bytes.
    const throughRequest = await get(`/api/maintenance-requests/${row.id}/photos/${photos[0].documentId}`);
    expect(throughRequest.statusCode, throughRequest.body).toBe(200);
    expect(Buffer.from(throughRequest.rawPayload).equals(PNG)).toBe(true);

    const events = (await get(`/api/maintenance-requests/${row.id}`)).json().events;
    expect(events.at(-1)).toMatchObject({ kind: 'photo_added', visibility: 'owner' });
  });

  it('refuses anything that is not a png or a jpeg', async () => {
    const row = await create();
    const res = await upload(row.id, { filename: 'racun.pdf', mime: 'application/pdf', content: PDF });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('unsupported_media_type');
    expect((await get(`/api/maintenance-requests/${row.id}`)).json().photos).toEqual([]);
  });

  it('lets the assigned technician add a photo and keeps everyone else out', async () => {
    const mine = await create();
    const theirs = await create();
    await post(`/api/maintenance-requests/${mine.id}/assign`, { assigneeUserId: tech.id });
    const ok = await upload(mine.id, { filename: 'popraveno.jpg', mime: 'image/jpeg', content: PNG }, tech.cookie);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().photos[0].uploadedByName).toBe('Стефан Стефановски');
    expect((await upload(theirs.id, { filename: 'x.png', mime: 'image/png', content: PNG }, tech.cookie)).statusCode).toBe(404);
  });

  it('gives a technician the photos of their own request and no other document of the tenant', async () => {
    const mine = await create();
    const theirs = await create();
    await post(`/api/maintenance-requests/${mine.id}/assign`, { assigneeUserId: tech.id });
    const ours = (await upload(mine.id, { filename: 'moe.png', mime: 'image/png', content: PNG })).json().photos[0].documentId;
    const notOurs = (await upload(theirs.id, { filename: 'tugo.png', mime: 'image/png', content: PNG })).json().photos[0].documentId;

    const ok = await get(`/api/maintenance-requests/${mine.id}/photos/${ours}`, tech.cookie);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(Buffer.from(ok.rawPayload).equals(PNG)).toBe(true);
    // A request that is not theirs is a 404, and so is every photo hanging on it.
    expect((await get(`/api/maintenance-requests/${theirs.id}/photos/${notOurs}`, tech.cookie)).statusCode).toBe(404);
    // Nor is the document reachable the generic way: that is the whole point of the new route.
    expect((await get(`/api/documents/${notOurs}`, tech.cookie)).statusCode).toBe(403);
    expect((await get(`/api/documents/${notOurs}/download`, tech.cookie)).statusCode).toBe(403);
    expect((await get(`/api/buildings/${A.buildingId}/documents?kind=photo`, tech.cookie)).statusCode).toBe(403);
    // The manager keeps both doors.
    expect((await get(`/api/documents/${notOurs}/download`)).statusCode).toBe(200);
    expect((await get(`/api/buildings/${A.buildingId}/documents?kind=photo`)).statusCode).toBe(200);
  });

  it('deletes a photo, its document row and its bytes', async () => {
    const row = await create();
    const documentId = (await upload(row.id, { filename: 'za-brisenje.png', mime: 'image/png', content: PNG })).json().photos[0].documentId;
    const year = String(new Date().getUTCFullYear());
    const before = await readdir(join(t.dataDir, 'documents', a.tenantId, year));
    const res = await t.app.inject({ method: 'DELETE', url: `/api/maintenance-requests/${row.id}/photos/${documentId}`, headers: { cookie: a.cookie } });
    expect(res.statusCode).toBe(204);
    expect((await get(`/api/maintenance-requests/${row.id}`)).json().photos).toEqual([]);
    expect((await get(`/api/documents/${documentId}`)).statusCode).toBe(404);
    const after = await readdir(join(t.dataDir, 'documents', a.tenantId, year));
    expect(after.length).toBe(before.length - 1);
    // A technician may add to their own request but never remove evidence.
    expect((await t.app.inject({ method: 'DELETE', url: `/api/maintenance-requests/${row.id}/photos/${documentId}`, headers: { cookie: tech.cookie } })).statusCode).toBe(403);
  });

  it('drops the gallery entry when the document itself is deleted', async () => {
    const row = await create();
    const documentId = (await upload(row.id, { filename: 'preku-dokumenti.png', mime: 'image/png', content: PNG })).json().photos[0].documentId;
    const res = await t.app.inject({ method: 'DELETE', url: `/api/documents/${documentId}`, headers: { cookie: a.cookie } });
    expect(res.statusCode).toBe(204);
    expect((await get(`/api/maintenance-requests/${row.id}`)).json().photos).toEqual([]);
  });

  it('closes with a cost through the existing expense flow and moves the fund', async () => {
    const row = await create();
    await post(`/api/maintenance-requests/${row.id}/assign`, { assigneeUserId: tech.id });
    await post(`/api/maintenance-requests/${row.id}/status`, { status: 'in_progress' }, tech.cookie);

    const fundBefore = (await get(`/api/buildings/${A.buildingId}/reserve-fund`)).json().balanceMinor;
    expect(fundBefore).toBe(3_500_000);

    const done = await post(`/api/maintenance-requests/${row.id}/status`, {
      status: 'done', note: 'Заменета спојка.', visibility: 'owner',
      cost: { fund: 'reserve', costMinor: 1_200_000, supplierId },
    });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().status).toBe('done');
    expect(done.json().fund).toBe('reserve');
    expect(done.json().costMinor).toBe(1_200_000);
    expect(done.json().supplierId).toBe(supplierId);
    const expenseId = done.json().expenseId;
    expect(expenseId).toEqual(expect.any(String));

    const expense = (await get(`/api/buildings/${A.buildingId}/reserve-fund/expenses`)).json().rows.find((e: { id: string }) => e.id === expenseId);
    expect(expense).toMatchObject({
      fund: 'reserve', amountMinor: 1_200_000, supplierId,
      description: 'Одржување: Водовод и канализација — Протекува цевка во визбата',
    });

    const state = (await get(`/api/buildings/${A.buildingId}/reserve-fund`)).json();
    expect(state.balanceMinor).toBe(3_500_000 - 1_200_000);
    const tx = (await get(`/api/buildings/${A.buildingId}/reserve-fund/transactions`)).json().rows;
    expect(tx[0]).toMatchObject({ kind: 'expense', fund: 'reserve', amountMinor: -1_200_000, refType: 'expense', refId: expenseId });
  });

  it('refuses a technician the cost, and books nothing when it does', async () => {
    const row = await create();
    await post(`/api/maintenance-requests/${row.id}/assign`, { assigneeUserId: tech.id });
    const before = (await get(`/api/buildings/${A.buildingId}/reserve-fund`)).json().balanceMinor;
    const res = await post(`/api/maintenance-requests/${row.id}/status`, { status: 'done', cost: { fund: 'reserve', costMinor: 500_000 } }, tech.cookie);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('cost_requires_write_role');
    expect((await get(`/api/maintenance-requests/${row.id}`, tech.cookie)).json().status).toBe('assigned');
    expect((await get(`/api/buildings/${A.buildingId}/reserve-fund`)).json().balanceMinor).toBe(before);
    // Without a cost the same technician closes it.
    const ok = await post(`/api/maintenance-requests/${row.id}/status`, { status: 'done', cost: null }, tech.cookie);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().expenseId).toBeNull();
  });

  it('rolls the whole close back when the cost cannot be booked', async () => {
    const row = await create();
    await post(`/api/maintenance-requests/${row.id}/assign`, { assigneeUserId: tech.id });
    const before = (await get(`/api/buildings/${A.buildingId}/reserve-fund`)).json().balanceMinor;
    const res = await post(`/api/maintenance-requests/${row.id}/status`, {
      status: 'done', cost: { fund: 'reserve', costMinor: 100_000, supplierId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_reference');
    expect((await get(`/api/maintenance-requests/${row.id}`)).json().status).toBe('assigned');
    expect((await get(`/api/buildings/${A.buildingId}/reserve-fund`)).json().balanceMinor).toBe(before);
  });

  it('refuses a photo on a closed request', async () => {
    const row = await create();
    await post(`/api/maintenance-requests/${row.id}/status`, { status: 'rejected', note: 'Двојна пријава.' });
    const res = await upload(row.id, { filename: 'docna.png', mime: 'image/png', content: PNG });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('status_locked');
  });

  it('will not delete a photo an expense is attached to', async () => {
    const row = await create();
    const documentId = (await upload(row.id, { filename: 'dokaz.png', mime: 'image/png', content: PNG })).json().photos[0].documentId;
    await post(`/api/maintenance-requests/${row.id}/assign`, { assigneeUserId: tech.id });
    const done = await post(`/api/maintenance-requests/${row.id}/status`, {
      status: 'done', cost: { fund: 'reserve', costMinor: 640_000, documentId },
    });
    expect(done.statusCode, done.body).toBe(200);

    const res = await t.app.inject({ method: 'DELETE', url: `/api/maintenance-requests/${row.id}/photos/${documentId}`, headers: { cookie: a.cookie } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('document_referenced');
    // The gallery entry, the document and the expense's attachment all survive the refusal.
    expect((await get(`/api/maintenance-requests/${row.id}`)).json().photos.map((p: { documentId: string }) => p.documentId)).toEqual([documentId]);
    expect((await get(`/api/documents/${documentId}`)).statusCode).toBe(200);
    const expense = (await get(`/api/buildings/${A.buildingId}/reserve-fund/expenses`)).json().rows.find((e: { id: string }) => e.id === done.json().expenseId);
    expect(expense.documentId).toBe(documentId);
  });

  it('refuses a cost on anything but a close, before it writes', async () => {
    const row = await create();
    await post(`/api/maintenance-requests/${row.id}/assign`, { assigneeUserId: tech.id });
    const before = (await get(`/api/buildings/${A.buildingId}/reserve-fund`)).json().balanceMinor;
    const res = await post(`/api/maintenance-requests/${row.id}/status`, { status: 'in_progress', cost: { fund: 'reserve', costMinor: 500_000 } }, tech.cookie);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('validation');
    expect((await get(`/api/maintenance-requests/${row.id}`, tech.cookie)).json().status).toBe('assigned');
    expect((await get(`/api/buildings/${A.buildingId}/reserve-fund`)).json().balanceMinor).toBe(before);
  });

  it('caps the gallery at twelve photos', async () => {
    const row = await create();
    for (let i = 0; i < 12; i += 1) {
      const res = await upload(row.id, { filename: `foto-${i}.png`, mime: 'image/png', content: PNG });
      expect(res.statusCode, res.body).toBe(201);
    }
    const res = await upload(row.id, { filename: 'trinaesetta.png', mime: 'image/png', content: PNG });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('too_many_photos');
    expect((await get(`/api/maintenance-requests/${row.id}`)).json().photoCount).toBe(12);
  });

  it('books one expense when the same close arrives twice at once', async () => {
    const row = await create();
    await post(`/api/maintenance-requests/${row.id}/assign`, { assigneeUserId: tech.id });
    const body = { status: 'done', note: 'Готово.', cost: { fund: 'reserve', costMinor: 777_777 } };
    const before = (await get(`/api/buildings/${A.buildingId}/reserve-fund`)).json().balanceMinor;
    const [one, two] = await Promise.all([
      post(`/api/maintenance-requests/${row.id}/status`, body),
      post(`/api/maintenance-requests/${row.id}/status`, body),
    ]);
    expect([one.statusCode, two.statusCode].sort()).toEqual([200, 409]);
    const loser = one.statusCode === 409 ? one : two;
    expect(loser.json().error.code).toBe('status_locked');
    // One close, one expense, one posting: the claim is the fence (plan addendum 4).
    const expenses = (await get(`/api/buildings/${A.buildingId}/reserve-fund/expenses`)).json().rows
      .filter((e: { amountMinor: number }) => e.amountMinor === 777_777);
    expect(expenses).toHaveLength(1);
    expect((await get(`/api/maintenance-requests/${row.id}`)).json().expenseId).toBe(expenses[0].id);
    expect((await get(`/api/buildings/${A.buildingId}/reserve-fund`)).json().balanceMinor).toBe(before - 777_777);
  });
});
