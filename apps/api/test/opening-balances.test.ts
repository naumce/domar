import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

describe('owner opening balances', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let buildingId: string; let o1: string; let o2: string; let periodId: string;

  const post = (url: string, payload: Record<string, unknown>, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? a.cookie }, payload });
  const get = (url: string, cookie?: string) => t.app.inject({ method: 'GET', url, headers: { cookie: cookie ?? a.cookie } });
  const base = () => `/api/buildings/${buildingId}/opening-balances`;

  beforeAll(async () => {
    t = await createTestApp();
    a = await registerTenant(t.app, 'firma-ob');
    const vatId = (await get('/api/tax-rates')).json().rows.find((r: { rateBp: number }) => r.rateBp === 1800).id;
    o1 = (await post('/api/contacts', { firstName: 'Марко', lastName: 'Марков' })).json().id;
    o2 = (await post('/api/contacts', { firstName: 'Ана', lastName: 'Бошковска' })).json().id;
    buildingId = (await post('/api/buildings', { name: 'Партизанска 12' })).json().id;
    await post(`/api/buildings/${buildingId}/units`, { label: '1', kind: 'apartment', areaM2: 50, ownerContactId: o1 });
    await post(`/api/buildings/${buildingId}/units`, { label: '2', kind: 'apartment', areaM2: 50, ownerContactId: o2 });
    const svc = (await post('/api/services', { name: 'Чистење', pricing: 'fixed_per_unit', defaultPriceMinor: 30000, taxRateId: vatId, appliesTo: ['apartment'] })).json().id;
    await post(`/api/buildings/${buildingId}/services`, { serviceId: svc, startsPeriod: '2026-01' });
  });
  afterAll(async () => { await t.close(); });

  it('books two rows for one owner and reports the balance per fund', async () => {
    const res = await post(base(), { rows: [
      { contactId: o1, amountMinor: 120000 },
      { contactId: o1, fund: 'reserve', amountMinor: -20000, note: 'претплата' },
    ] });
    expect(res.statusCode).toBe(201);
    expect(res.json().created).toBe(2);
    expect(res.json().postings[0]).toMatchObject({ contactId: o1, fund: 'regular', amountMinor: 120000 });

    const list = await get(base());
    expect(list.statusCode).toBe(200);
    expect(list.json().hasPublishedPeriod).toBe(false);
    const rows: { contactId: string; regularMinor: number; reserveMinor: number; balanceMinor: number; openingMinor: number }[] = list.json().rows;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.contactId === o1)).toMatchObject({ regularMinor: 120000, reserveMinor: -20000, balanceMinor: 100000, openingMinor: 100000 });
    expect(rows.find((r) => r.contactId === o2)).toMatchObject({ regularMinor: 0, reserveMinor: 0, balanceMinor: 0, openingMinor: 0 });
  });

  it('rejects a zero amount and a contact from another organization', async () => {
    const zero = await post(base(), { rows: [{ contactId: o1, amountMinor: 0 }] });
    expect(zero.statusCode).toBe(400);
    expect(zero.json().error.code).toBe('validation');
    const b = await registerTenant(t.app, 'firma-ob-2');
    const foreign = (await post('/api/contacts', { firstName: 'F', lastName: 'F' }, b.cookie)).json().id;
    const res = await post(base(), { rows: [{ contactId: foreign, amountMinor: 1000 }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_reference');
    expect((await get(base(), b.cookie)).statusCode).toBe(404);
    expect((await post(base(), { rows: [{ contactId: foreign, amountMinor: 1000 }] }, b.cookie)).statusCode).toBe(404);
  });

  it('rejects a contact of ours who owns no unit in the building', async () => {
    const stranger = (await post('/api/contacts', { firstName: 'Без', lastName: 'Стан' })).json().id;
    const res = await post(base(), { rows: [{ contactId: o1, amountMinor: 1000 }, { contactId: stranger, amountMinor: 1000 }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_reference');
    expect(res.json().error.details).toMatchObject({ contactIds: [stranger] });

    // nothing was written: the o1 row of the batch rolled back with it
    const rows: { contactId: string; regularMinor: number; reserveMinor: number }[] = (await get(base())).json().rows;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.contactId === o1)).toMatchObject({ regularMinor: 120000, reserveMinor: -20000 });
  });

  it('a generated invoice starts from the opening balance', async () => {
    periodId = (await post(`/api/buildings/${buildingId}/periods`, { period: '2026-09' })).json().id;
    await post(`/api/buildings/${buildingId}/periods/${periodId}/generate`, {});
    const rows: { contactId: string; totalMinor: number; previousBalanceMinor: number; amountDueMinor: number }[] =
      (await get(`/api/invoices?buildingId=${buildingId}&period=2026-09`)).json().rows;
    // 300,00 net + 18% VAT = 354,00 for each apartment
    expect(rows.find((r) => r.contactId === o1)).toMatchObject({ totalMinor: 35400, previousBalanceMinor: 100000, amountDueMinor: 135400 });
    expect(rows.find((r) => r.contactId === o2)).toMatchObject({ totalMinor: 35400, previousBalanceMinor: 0, amountDueMinor: 35400 });
  });

  it('refuses once a period is published unless force is set', async () => {
    await post(`/api/buildings/${buildingId}/periods/${periodId}/publish`, {});
    const refused = await post(base(), { rows: [{ contactId: o2, amountMinor: 5000 }] });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('period_published');

    const forced = await post(base(), { rows: [{ contactId: o2, amountMinor: 5000 }], force: true });
    expect(forced.statusCode).toBe(201);

    const list = await get(base());
    expect(list.json().hasPublishedPeriod).toBe(true);
    const rows: { contactId: string; regularMinor: number; reserveMinor: number; balanceMinor: number; openingMinor: number }[] = list.json().rows;
    // o1: 120000 opening + 35400 charge; o2: 35400 charge + 5000 forced opening
    expect(rows.find((r) => r.contactId === o1)).toMatchObject({ regularMinor: 155400, reserveMinor: -20000, balanceMinor: 135400, openingMinor: 100000 });
    expect(rows.find((r) => r.contactId === o2)).toMatchObject({ regularMinor: 40400, reserveMinor: 0, balanceMinor: 40400, openingMinor: 5000 });
  });
});
