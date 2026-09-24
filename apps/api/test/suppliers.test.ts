import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupPublishedBuilding } from './billing-fixture.js';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

const PDF = Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1');

function multipart(fields: Record<string, string>, file: { filename: string; mime: string; content: Buffer }) {
  const boundary = `----domar${Math.random().toString(36).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.mime}\r\n\r\n`, 'utf8'));
  parts.push(file.content, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('suppliers and contracts', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let b: Awaited<ReturnType<typeof registerTenant>>;
  let A: Awaited<ReturnType<typeof setupPublishedBuilding>>;
  let supplierId = '';
  let documentId = '';

  const post = (url: string, payload: Record<string, unknown> = {}, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? a.cookie }, payload });
  const patch = (url: string, payload: Record<string, unknown>, cookie?: string) =>
    t.app.inject({ method: 'PATCH', url, headers: { cookie: cookie ?? a.cookie }, payload });
  const del = (url: string, cookie?: string) => t.app.inject({ method: 'DELETE', url, headers: { cookie: cookie ?? a.cookie } });
  const get = (url: string, cookie?: string) => t.app.inject({ method: 'GET', url, headers: { cookie: cookie ?? a.cookie } });

  beforeAll(async () => {
    t = await createTestApp();
    a = await registerTenant(t.app, 'firma-sup');
    b = await registerTenant(t.app, 'firma-sup-other');
    A = await setupPublishedBuilding(t.app, a.cookie);
    const m = multipart({ kind: 'contract', title: 'Договор за управување' }, { filename: 'dogovor.pdf', mime: 'application/pdf', content: PDF });
    documentId = (await t.app.inject({ method: 'POST', url: `/api/buildings/${A.buildingId}/documents`, headers: { cookie: a.cookie, ...m.headers }, payload: m.payload })).json().id;
  });
  afterAll(async () => { await t.close(); });

  it('creates, lists and patches a supplier', async () => {
    const res = await post('/api/suppliers', { name: 'Лифт Сервис ДООЕЛ', companyNumber: '7654321', vatNumber: 'MK4030999123456', email: 'info@liftservis.mk', iban: 'MK07210000000000019' });
    expect(res.statusCode).toBe(201);
    supplierId = res.json().id;
    expect(res.json().isActive).toBe(true);
    const list = (await get('/api/suppliers')).json();
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0].name).toBe('Лифт Сервис ДООЕЛ');
    const patched = await patch(`/api/suppliers/${supplierId}`, { phone: '02 3100 100', isActive: false });
    expect(patched.json().phone).toBe('02 3100 100');
    expect((await get('/api/suppliers')).json().rows).toHaveLength(0);
    expect((await get('/api/suppliers?includeInactive=true')).json().rows).toHaveLength(1);
    await patch(`/api/suppliers/${supplierId}`, { isActive: true });
  });

  it('keeps suppliers inside their tenant', async () => {
    expect((await get('/api/suppliers', b.cookie)).json().rows).toEqual([]);
    expect((await patch(`/api/suppliers/${supplierId}`, { name: 'x' }, b.cookie)).statusCode).toBe(404);
    expect((await del(`/api/suppliers/${supplierId}`, b.cookie)).statusCode).toBe(404);
  });

  it('creates a management contract whose end date starts the Art. 30 clock', async () => {
    const res = await post(`/api/buildings/${A.buildingId}/contracts`, {
      kind: 'management', title: 'Договор за управување 2026', startsOn: '2026-01-01', endsOn: '2026-09-10',
      noticeDays: 30, amountMinor: 1500000, documentId,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().supplierId).toBeNull(); // the manager's own contract
    expect(res.json().startsOn).toBe('2026-01-01');
    expect(res.json().endsOn).toBe('2026-09-10');
    const duties = (await get(`/api/buildings/${A.buildingId}/compliance`)).json().duties;
    const handover = duties.find((d: { key: string }) => d.key === 'handover');
    // The end date is in the past by more than eight days on any run after 2026-09-18.
    expect(['due', 'overdue']).toContain(handover.status);
    // endsOn 2026-09-10 + 8 days, read as a civil day in the tenant's Europe/Skopje timezone (DST,
    // UTC+2 in September), not as a bare UTC date — see evaluate.ts's civilDay/localDayStart.
    expect(handover.dueAt).toBe('2026-09-17T22:00:00.000Z');
  });

  it('creates a service contract for a supplier and lists both', async () => {
    const res = await post(`/api/buildings/${A.buildingId}/contracts`, { kind: 'service', title: 'Одржување лифт', startsOn: '2026-02-01', supplierId });
    expect(res.statusCode).toBe(201);
    expect(res.json().endsOn).toBeNull();
    const rows = (await get(`/api/buildings/${A.buildingId}/contracts`)).json().rows;
    expect(rows).toHaveLength(2);
    expect(rows.map((r: { kind: string }) => r.kind).sort()).toEqual(['management', 'service']);
    expect(rows.find((r: { kind: string }) => r.kind === 'service').supplier.name).toBe('Лифт Сервис ДООЕЛ');
  });

  it('validates contract patches and rejects a management contract with a supplier', async () => {
    const rows = (await get(`/api/buildings/${A.buildingId}/contracts`)).json().rows;
    const management = rows.find((r: { kind: string }) => r.kind === 'management');
    const service = rows.find((r: { kind: string }) => r.kind === 'service');

    const endsBeforeStarts = await patch(`/api/buildings/${A.buildingId}/contracts/${management.id}`, { endsOn: '2025-12-31' });
    expect(endsBeforeStarts.statusCode).toBe(400);
    expect(endsBeforeStarts.json().error.code).toBe('validation');

    const startsAfterEnds = await patch(`/api/buildings/${A.buildingId}/contracts/${management.id}`, { startsOn: '2026-09-15' });
    expect(startsAfterEnds.statusCode).toBe(400);
    expect(startsAfterEnds.json().error.code).toBe('validation');

    expect((await patch(`/api/buildings/${A.buildingId}/contracts/${service.id}`, { nope: 'x' })).statusCode).toBe(400);
    expect((await patch(`/api/buildings/${A.buildingId}/contracts/${service.id}`, {})).statusCode).toBe(400);

    const managementWithSupplier = await post(`/api/buildings/${A.buildingId}/contracts`, {
      kind: 'management', title: 'x', startsOn: '2026-01-01', supplierId,
    });
    expect(managementWithSupplier.statusCode).toBe(400);
    expect(managementWithSupplier.json().error.code).toBe('validation');

    const serviceMadeManagementWithSupplier = await patch(`/api/buildings/${A.buildingId}/contracts/${service.id}`, { kind: 'management' });
    expect(serviceMadeManagementWithSupplier.statusCode).toBe(400);
    expect(serviceMadeManagementWithSupplier.json().error.code).toBe('validation');

    expect((await patch(`/api/suppliers/${supplierId}`, { nope: 'x' })).statusCode).toBe(400);
    expect((await patch(`/api/suppliers/${supplierId}`, {})).statusCode).toBe(400);
  });

  it('refuses a supplier or document from another tenant', async () => {
    const other = (await post('/api/suppliers', { name: 'Туѓ добавувач' }, b.cookie)).json();
    const res = await post(`/api/buildings/${A.buildingId}/contracts`, { kind: 'service', title: 'x', startsOn: '2026-02-01', supplierId: other.id });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_reference');
  });

  it('refuses to delete a supplier or a document a contract points at', async () => {
    const supplierDel = await del(`/api/suppliers/${supplierId}`);
    expect(supplierDel.statusCode).toBe(409);
    expect(supplierDel.json().error.code).toBe('supplier_referenced');
    const docDel = await del(`/api/documents/${documentId}`);
    expect(docDel.statusCode).toBe(409);
    expect(docDel.json().error.code).toBe('document_referenced');
  });

  it('books an expense against a supplier and a document', async () => {
    const res = await post(`/api/buildings/${A.buildingId}/reserve-fund/expenses`, {
      fund: 'reserve', description: 'Поправка на лифт', amountMinor: 1200000, paidAt: '2026-09-20T10:00:00.000Z',
      supplierId, documentId,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().supplierId).toBe(supplierId);
    expect(res.json().documentId).toBe(documentId);
    const rows = (await get(`/api/buildings/${A.buildingId}/reserve-fund/expenses`)).json().rows;
    expect(rows[0].supplierId).toBe(supplierId);
    // The ledger is untouched by the two new columns: the expense still moves the reserve fund.
    const state = (await get(`/api/buildings/${A.buildingId}/reserve-fund`)).json();
    expect(state.balanceMinor).toBe(3500000 - 1200000);
    const bad = await post(`/api/buildings/${A.buildingId}/reserve-fund/expenses`, {
      fund: 'reserve', description: 'x', amountMinor: 100, paidAt: '2026-09-20T10:00:00.000Z',
      supplierId: '00000000-0000-4000-8000-000000000000',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('invalid_reference');
  });

  it('deletes a contract and then the things it pointed at', async () => {
    const rows = (await get(`/api/buildings/${A.buildingId}/contracts`)).json().rows;
    for (const r of rows) expect((await del(`/api/buildings/${A.buildingId}/contracts/${r.id}`)).statusCode).toBe(204);
    expect((await get(`/api/buildings/${A.buildingId}/contracts`)).json().rows).toEqual([]);
    // The expense still points at both, so both are still undeletable.
    expect((await del(`/api/suppliers/${supplierId}`)).statusCode).toBe(409);
    expect((await del(`/api/documents/${documentId}`)).statusCode).toBe(409);
    // ... and the handover duty falls back to n/a without a management contract.
    const handover = (await get(`/api/buildings/${A.buildingId}/compliance`)).json().duties.find((d: { key: string }) => d.key === 'handover');
    expect(handover.status).toBe('n/a');
  });
});
