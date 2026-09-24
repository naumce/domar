import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

const CSV = 'број;кат;тип;површина;удел;име;презиме;е-пошта;телефон;почетно салдо\n'
  + '1;1;стан;54,5;0,085;Марко;Марков;marko@example.mk;070111222;1.200,00\n'
  + '2;1;стан;62;;Ана;Бошковска;ana@example.mk;;-450,50\n'
  + 'P-1;;паркинг;;;;;;;\n';

describe('unit import', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let buildingId: string;

  const post = (url: string, payload: Record<string, unknown>, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? a.cookie }, payload });
  const get = (url: string, cookie?: string) => t.app.inject({ method: 'GET', url, headers: { cookie: cookie ?? a.cookie } });
  const importUrl = () => `/api/buildings/${buildingId}/import/units`;

  beforeAll(async () => {
    t = await createTestApp();
    a = await registerTenant(t.app, 'firma-imp');
    buildingId = (await post('/api/buildings', { name: 'Партизанска 12' })).json().id;
  });
  afterAll(async () => { await t.close(); });

  it('previews without writing anything', async () => {
    const res = await post(importUrl(), { content: CSV, dryRun: true });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dryRun).toBe(true);
    expect(body.hasPublishedPeriod).toBe(false);
    expect(body.blocked).toBeNull();
    expect(body.errors).toEqual([]);
    expect(body.conflicts).toEqual([]);
    expect(body.rows).toHaveLength(3);
    expect(body.rows[0]).toMatchObject({ label: '1', kind: 'apartment', areaM2: 54.5, ownerLastName: 'Марков', openingBalanceMinor: 120000 });
    expect(body.counts).toEqual({ units: 3, newContacts: 2, existingContacts: 0, openingBalances: 2, conflicts: 0 });
    expect((await get(`/api/buildings/${buildingId}/units`)).json().rows).toHaveLength(0);
    expect((await get('/api/contacts')).json().total).toBe(0);
  });

  it('commits units, contacts and opening balances in one go', async () => {
    const res = await post(importUrl(), { content: CSV });
    expect(res.statusCode).toBe(200);
    expect(res.json().dryRun).toBe(false);
    expect(res.json().counts).toEqual({ units: 3, newContacts: 2, existingContacts: 0, openingBalances: 2, conflicts: 0 });

    const units: { label: string; areaM2: number | null; owner: { lastName: string } | null }[] = (await get(`/api/buildings/${buildingId}/units`)).json().rows;
    expect(units).toHaveLength(3);
    expect(units.find((u) => u.label === '1')).toMatchObject({ areaM2: 54.5, owner: { lastName: 'Марков' } });
    expect(units.find((u) => u.label === 'P-1')!.owner).toBeNull();

    const balances: { lastName: string; regularMinor: number; balanceMinor: number }[] = (await get(`/api/buildings/${buildingId}/opening-balances`)).json().rows;
    expect(balances).toHaveLength(2);
    expect(balances.find((b) => b.lastName === 'Марков')).toMatchObject({ regularMinor: 120000, balanceMinor: 120000 });
    expect(balances.find((b) => b.lastName === 'Бошковска')).toMatchObject({ regularMinor: -45050, balanceMinor: -45050 });
    expect((await get('/api/contacts')).json().total).toBe(2);
  });

  it('refuses existing labels in fail mode and skips them in skip mode', async () => {
    const failed = await post(importUrl(), { content: CSV });
    expect(failed.statusCode).toBe(409);
    expect(failed.json().error.code).toBe('label_conflict');
    expect([...failed.json().error.details.labels].sort()).toEqual(['1', '2', 'P-1']);

    const second = 'број;тип;презиме;е-пошта;почетно салдо\n'
      + '1;стан;Марков;marko@example.mk;0\n'
      + '3;стан;Бошковска;ana@example.mk;0\n';
    const skipped = await post(importUrl(), { content: second, mode: 'skip' });
    expect(skipped.statusCode).toBe(200);
    expect(skipped.json().conflicts).toEqual(['1']);
    expect(skipped.json().counts).toEqual({ units: 1, newContacts: 0, existingContacts: 1, openingBalances: 0, conflicts: 1 });
    expect((await get(`/api/buildings/${buildingId}/units`)).json().rows).toHaveLength(4);
    expect((await get('/api/contacts')).json().total).toBe(2);
  });

  it('imports the valid rows and reports the broken ones', async () => {
    const res = await post(importUrl(), { content: 'број;тип\n4;стан\n5;кутија\n' });
    expect(res.statusCode).toBe(200);
    expect(res.json().counts.units).toBe(1);
    expect(res.json().errors).toEqual([{ line: 3, message: 'unknown kind: кутија' }]);
    expect((await get(`/api/buildings/${buildingId}/units`)).json().rows).toHaveLength(5);
  });

  it('matches an existing owner whose name differs only in letter case', async () => {
    await post('/api/contacts', { firstName: 'Ана', lastName: 'Ангелова' });
    const before = (await get('/api/contacts')).json().total;
    const res = await post(importUrl(), { content: 'број;тип;име;презиме\n7;стан;ана;ангелова\n' });
    expect(res.statusCode).toBe(200);
    expect(res.json().counts).toMatchObject({ units: 1, newContacts: 0, existingContacts: 1 });
    expect((await get('/api/contacts')).json().total).toBe(before);
  });

  it('refuses a file with more rows than the cap', async () => {
    const content = 'број;тип\n' + Array.from({ length: 5001 }, (_, i) => `X${i};стан`).join('\n') + '\n';
    const res = await post(importUrl(), { content, dryRun: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('too_many_rows');
  });

  it('reports the published-period block on preview and needs force to commit', async () => {
    const vatId = (await get('/api/tax-rates')).json().rows.find((r: { rateBp: number }) => r.rateBp === 1800).id;
    const pub = (await post('/api/buildings', { name: 'Илинденска 5' })).json().id;
    const owner = (await post('/api/contacts', { firstName: 'Петар', lastName: 'Петров' })).json().id;
    await post(`/api/buildings/${pub}/units`, { label: '1', kind: 'apartment', areaM2: 50, ownerContactId: owner });
    const svc = (await post('/api/services', { name: 'Чистење', pricing: 'fixed_per_unit', defaultPriceMinor: 30000, taxRateId: vatId, appliesTo: ['apartment'] })).json().id;
    await post(`/api/buildings/${pub}/services`, { serviceId: svc, startsPeriod: '2026-01' });
    const periodId = (await post(`/api/buildings/${pub}/periods`, { period: '2026-09' })).json().id;
    await post(`/api/buildings/${pub}/periods/${periodId}/generate`, {});
    expect((await post(`/api/buildings/${pub}/periods/${periodId}/publish`, {})).statusCode).toBe(200);

    const url = `/api/buildings/${pub}/import/units`;
    const file = 'број;тип;име;презиме;почетно салдо\n10;стан;Петар;Петров;500,00\n';
    const preview = await post(url, { content: file, dryRun: true });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().hasPublishedPeriod).toBe(true);
    expect(preview.json().blocked).toBe('period_published');
    expect(preview.json().counts).toMatchObject({ units: 1, openingBalances: 1, existingContacts: 1 });

    const refused = await post(url, { content: file });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('period_published');
    expect((await get(`/api/buildings/${pub}/units`)).json().rows).toHaveLength(1);

    const forced = await post(url, { content: file, force: true });
    expect(forced.statusCode).toBe(200);
    expect(forced.json().blocked).toBeNull();
    expect(forced.json().hasPublishedPeriod).toBe(true);
    expect(forced.json().counts).toMatchObject({ units: 1, newContacts: 0, existingContacts: 1, openingBalances: 1 });
    const balances: { contactId: string; openingMinor: number }[] = (await get(`/api/buildings/${pub}/opening-balances`)).json().rows;
    expect(balances.find((b) => b.contactId === owner)!.openingMinor).toBe(50000);

    // the refused attempt rolled back with its audit row, so this building has exactly the forced one
    const audit = (await t.db.query.auditLogs.findMany()).filter((r) => r.action === 'import.units' && r.entityId === pub);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.after).toMatchObject({ force: true, afterPublishedPeriod: true });
  });

  it('is not found for a building of another organization', async () => {
    const b = await registerTenant(t.app, 'firma-imp-2');
    const res = await post(importUrl(), { content: CSV, dryRun: true }, b.cookie);
    expect(res.statusCode).toBe(404);
  });
});
