import { createHash, randomUUID } from 'node:crypto';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { schema } from '@domar/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contentDisposition, LocalDiskStore } from '../src/documents/store.js';
import { setupPublishedBuilding } from './billing-fixture.js';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1');
const PDF_SHA256 = createHash('sha256').update(PDF).digest('hex');

/** A multipart body `app.inject` can post. Fields come first: busboy only exposes what precedes the file. */
function multipart(fields: Record<string, string>, file: { filename: string; mime: string; content: Buffer }) {
  const boundary = `----domar${Math.random().toString(36).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.mime}\r\n\r\n`, 'utf8'));
  parts.push(file.content);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/** busboy calls an `application/octet-stream` part a file even with no `filename` attribute. */
function multipartNoFilename(fields: Record<string, string>, content: Buffer) {
  const boundary = `----domar${Math.random().toString(36).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"\r\nContent-Type: application/octet-stream\r\n\r\n`, 'utf8'));
  parts.push(content);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('documents', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let b: Awaited<ReturnType<typeof registerTenant>>;
  let A: Awaited<ReturnType<typeof setupPublishedBuilding>>;
  let minutesId = '';

  const upload = (buildingId: string, fields: Record<string, string>, file: { filename: string; mime: string; content: Buffer }, cookie?: string) => {
    const m = multipart(fields, file);
    return t.app.inject({ method: 'POST', url: `/api/buildings/${buildingId}/documents`, headers: { cookie: cookie ?? a.cookie, ...m.headers }, payload: m.payload });
  };
  const get = (url: string, cookie?: string) => t.app.inject({ method: 'GET', url, headers: { cookie: cookie ?? a.cookie } });
  /** The files tenant A actually has on disk this year. */
  const storedFiles = () => readdir(join(t.dataDir, 'documents', a.tenantId, String(new Date().getUTCFullYear()))).catch(() => [] as string[]);

  beforeAll(async () => {
    t = await createTestApp();
    a = await registerTenant(t.app, 'firma-doc');
    b = await registerTenant(t.app, 'firma-doc-other');
    A = await setupPublishedBuilding(t.app, a.cookie);
  });
  afterAll(async () => { await t.close(); });

  it('stores an uploaded PDF with its size and sha256 and writes the bytes under DATA_DIR', async () => {
    const res = await upload(A.buildingId, { kind: 'minutes', title: 'Записник од собир' }, { filename: 'записник.pdf', mime: 'application/pdf', content: PDF });
    expect(res.statusCode).toBe(201);
    const doc = res.json();
    minutesId = doc.id;
    expect(doc.kind).toBe('minutes');
    expect(doc.title).toBe('Записник од собир');
    expect(doc.fileName).toBe('записник.pdf');
    expect(doc.mime).toBe('application/pdf');
    expect(doc.sizeBytes).toBe(PDF.length);
    expect(doc.sha256).toBe(PDF_SHA256); // the sha256 of the exact bytes that were posted
    expect(doc.buildingId).toBe(A.buildingId);
    expect(doc.storageKey).toBeUndefined(); // the storage layout never leaves the server
    const meta = (await get(`/api/documents/${minutesId}`)).json();
    expect(meta.sha256).toBe(doc.sha256);
    await expect(access(join(t.dataDir, 'documents', a.tenantId, String(new Date().getUTCFullYear()), `${minutesId}.pdf`))).resolves.toBeUndefined();
  });

  it('streams the file back with a safe content-disposition', async () => {
    const res = await get(`/api/documents/${minutesId}/download`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="________.pdf"; filename*=UTF-8''${encodeURIComponent('записник.pdf')}`);
    expect(res.rawPayload.equals(PDF)).toBe(true);
  });

  it('percent-encodes the characters RFC 5987 does not allow in filename*', async () => {
    const header = contentDisposition('Записник (2026).pdf');
    expect(header).toBe("attachment; filename=\"__________2026_.pdf\"; filename*=UTF-8''%D0%97%D0%B0%D0%BF%D0%B8%D1%81%D0%BD%D0%B8%D0%BA%20%282026%29.pdf");
    expect(header.split("UTF-8''")[1]).not.toMatch(/[!'()*]/);
  });

  it('lists the documents of a building and filters by kind', async () => {
    await upload(A.buildingId, { kind: 'invoice_supplier', title: 'Фактура за лифт' }, { filename: 'lift.pdf', mime: 'application/pdf', content: PDF });
    const all = (await get(`/api/buildings/${A.buildingId}/documents`)).json();
    expect(all.rows).toHaveLength(2);
    const only = (await get(`/api/buildings/${A.buildingId}/documents?kind=minutes`)).json();
    expect(only.rows).toHaveLength(1);
    expect(only.rows[0].id).toBe(minutesId);
  });

  it('refuses a mime outside the allowlist and an empty file', async () => {
    const before = (await storedFiles()).length;
    const bad = await upload(A.buildingId, { kind: 'other', title: 'x' }, { filename: 'run.sh', mime: 'application/x-sh', content: Buffer.from('#!/bin/sh\n') });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('unsupported_media_type');
    const empty = await upload(A.buildingId, { kind: 'other', title: 'x' }, { filename: 'empty.txt', mime: 'text/plain', content: Buffer.alloc(0) });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.code).toBe('empty_file');
    // Neither rejection may leave bytes behind.
    expect(await storedFiles()).toHaveLength(before);
  });

  it('refuses an uploaded zip even though a generated one is allowed', async () => {
    // `application/zip` is in GENERATED_MIME, which only `createDocumentFromBuffer` passes; there is
    // deliberately no path from an HTTP upload to a stored archive (plan addendum 12).
    const res = await upload(A.buildingId, { kind: 'other', title: 'архива' }, { filename: 'podatoci.zip', mime: 'application/zip', content: Buffer.from('PK\u0003\u0004') });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('unsupported_media_type');
  });

  it('refuses a file part with no filename before writing anything', async () => {
    const before = (await storedFiles()).length;
    const m = multipartNoFilename({ kind: 'other', title: 'x' }, Buffer.from('bytes'));
    const res = await t.app.inject({ method: 'POST', url: `/api/buildings/${A.buildingId}/documents`, headers: { cookie: a.cookie, ...m.headers }, payload: m.payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('file_required');
    expect(await storedFiles()).toHaveLength(before);
  });

  it('refuses a file over 20 MB', async () => {
    const before = (await storedFiles()).length;
    const tooBig = await upload(A.buildingId, { kind: 'other', title: 'голема' }, { filename: 'big.txt', mime: 'text/plain', content: Buffer.alloc(20 * 1024 * 1024 + 1024, 0x41) });
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json().error.code).toBe('file_too_large');
    expect((await get(`/api/buildings/${A.buildingId}/documents`)).json().rows).toHaveLength(2);
    expect(await storedFiles()).toHaveLength(before); // the truncated file was deleted, not kept
  });

  it('is invisible to another tenant', async () => {
    expect((await get(`/api/documents/${minutesId}`, b.cookie)).statusCode).toBe(404);
    expect((await get(`/api/documents/${minutesId}/download`, b.cookie)).statusCode).toBe(404);
    expect((await get(`/api/buildings/${A.buildingId}/documents`, b.cookie)).statusCode).toBe(404);
    const res = await upload(A.buildingId, { kind: 'other', title: 'x' }, { filename: 'x.txt', mime: 'text/plain', content: Buffer.from('x') }, b.cookie);
    expect(res.statusCode).toBe(404);
  });

  it('deletes a document and its bytes', async () => {
    const created = (await upload(A.buildingId, { kind: 'other', title: 'за бришење' }, { filename: 'tmp.txt', mime: 'text/plain', content: Buffer.from('tmp') })).json();
    const res = await t.app.inject({ method: 'DELETE', url: `/api/documents/${created.id}`, headers: { cookie: a.cookie } });
    expect(res.statusCode).toBe(204);
    expect((await get(`/api/documents/${created.id}`)).statusCode).toBe(404);
    await expect(access(join(t.dataDir, 'documents', a.tenantId, String(new Date().getUTCFullYear()), `${created.id}.txt`))).rejects.toThrow();
  });

  it('shows the portal the minutes of a building the owner has a unit in, and nothing else', async () => {
    await t.app.inject({ method: 'PATCH', url: `/api/contacts/${A.owners.O1}`, headers: { cookie: a.cookie }, payload: { email: 'marko@firma-doc.mk' } });
    const invite = (await t.app.inject({ method: 'POST', url: `/api/contacts/${A.owners.O1}/portal-invite`, headers: { cookie: a.cookie }, payload: {} })).json();
    const reg = await t.app.inject({ method: 'POST', url: '/api/portal/register', payload: { code: invite.code, email: 'marko.owner@firma-doc.mk', password: 'correct-horse-1' } });
    expect(reg.statusCode).toBe(201);
    const raw = reg.headers['set-cookie'];
    const owner = String(Array.isArray(raw) ? raw[0] : raw).split(';')[0]!;

    const list = await t.app.inject({ method: 'GET', url: `/api/portal/documents?contactId=${A.owners.O1}&buildingId=${A.buildingId}`, headers: { cookie: owner } });
    expect(list.statusCode).toBe(200);
    expect(list.json().rows.map((r: { id: string }) => r.id)).toEqual([minutesId]); // the supplier invoice is not an owner's business

    const dl = await t.app.inject({ method: 'GET', url: `/api/documents/${minutesId}/download`, headers: { cookie: owner } });
    expect(dl.statusCode).toBe(401); // an owner cookie is not a staff session
    const portalDl = await t.app.inject({ method: 'GET', url: `/api/portal/documents/${minutesId}/download?contactId=${A.owners.O1}`, headers: { cookie: owner } });
    expect(portalDl.statusCode).toBe(200);
    expect(portalDl.rawPayload.equals(PDF)).toBe(true);

    const invoiceDoc = (await get(`/api/buildings/${A.buildingId}/documents?kind=invoice_supplier`)).json().rows[0];
    const forbidden = await t.app.inject({ method: 'GET', url: `/api/portal/documents/${invoiceDoc.id}/download?contactId=${A.owners.O1}`, headers: { cookie: owner } });
    expect(forbidden.statusCode).toBe(404);
  });

  it('refuses to delete a document a contract points at', async () => {
    const created = (await upload(A.buildingId, { kind: 'contract', title: 'Договор' }, { filename: 'dogovor.pdf', mime: 'application/pdf', content: PDF })).json();
    // Task 6 owns the contracts API; until it lands the reference is made directly in the table.
    await t.db.insert(schema.buildingContracts).values({
      tenantId: a.tenantId, buildingId: A.buildingId, kind: 'management', title: 'Управување',
      startsOn: '2026-01-01', documentId: created.id,
    });
    const res = await t.app.inject({ method: 'DELETE', url: `/api/documents/${created.id}`, headers: { cookie: a.cookie } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('document_referenced');
    // The row survives and so do its bytes.
    expect((await get(`/api/documents/${created.id}`)).statusCode).toBe(200);
    await expect(access(join(t.dataDir, 'documents', a.tenantId, String(new Date().getUTCFullYear()), `${created.id}.pdf`))).resolves.toBeUndefined();
  });

  it('refuses to delete the minutes of an assembly that was held', async () => {
    const created = (await upload(A.buildingId, { kind: 'minutes', title: 'Записник' }, { filename: 'zapisnik.pdf', mime: 'application/pdf', content: PDF })).json();
    // `minutes_document_id` is `on delete set null`, so without the guard the delete would succeed
    // and silently strip the held assembly — and its `assembly_held` evidence — of the minutes.
    await t.db.insert(schema.assemblies).values({
      tenantId: a.tenantId, buildingId: A.buildingId, scheduledAt: new Date(), status: 'held',
      heldAt: new Date(), minutesDocumentId: created.id,
    });
    const res = await t.app.inject({ method: 'DELETE', url: `/api/documents/${created.id}`, headers: { cookie: a.cookie } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('document_referenced');
    expect((await get(`/api/documents/${created.id}`)).statusCode).toBe(200);
  });
});

describe('LocalDiskStore', () => {
  let root = '';
  beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'domar-store-')); });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  it('leaves nothing behind when the source stream fails mid-write', async () => {
    const store = new LocalDiskStore(root);
    const tenantId = randomUUID();
    const key = `documents/${tenantId}/2026/${randomUUID()}.pdf`;
    // The failure is driven by the reader, so it cannot land before `pipeline` is listening.
    let sent = false;
    const source = new Readable({
      read() {
        if (sent) { this.destroy(new Error('connection reset')); return; }
        sent = true;
        this.push(Buffer.alloc(1024, 0x41));
      },
    });
    await expect(store.put(key, source)).rejects.toThrow('connection reset');
    await expect(readdir(join(root, 'documents', tenantId, '2026'))).resolves.toEqual([]);
  });

  it('refuses a key that is not a server-generated document key', async () => {
    const store = new LocalDiskStore(root);
    await expect(store.open('../../etc/passwd')).rejects.toThrow('invalid storage key');
    await expect(store.remove('documents/../../escape.pdf')).rejects.toThrow('invalid storage key');
  });
});
