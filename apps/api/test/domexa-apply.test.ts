import { mkdtemp, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runApply } from '../scripts/domexa/apply.js';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

const UNITS_CSV = 'број;кат;тип;површина;удел;име;презиме;е-пошта;телефон;почетно салдо\n'
  + '1;1;apartment;54.5;;Марко;Марков;marko@example.mk;070111222;1234.56\n'
  + '2;1;apartment;62;;Ана;Бошковска;ana@example.mk;070222333;-450.50\n'
  + 'P-1;;parking;;;Марко;Марков;marko@example.mk;070111222;0\n';

const PLANS: Record<string, unknown> = {
  'tax-rates.json': [{ name: '/', rateBp: 0, isDefault: false }, { name: 'ДДВ', rateBp: 1800, isDefault: true }],
  'services.json': [{ name: 'Чистење', category: 'Чистење', description: null, pricing: 'fixed_per_unit', defaultPriceMinor: 30000, taxRateName: 'ДДВ', appliesTo: ['apartment'], recurring: true }],
  'buildings.json': [{ key: 'b1', name: 'Партизанска 12', address: 'Партизанска 12', city: 'Скопје', postalCode: '1000' }],
  'building-services.json': [{ buildingKey: 'b1', serviceName: 'Чистење', priceMinor: 35000, pricing: null, frequency: 'monthly', intervalMonths: 1, startsPeriod: '2026-01', endsPeriod: null }],
  'reserve-fund.json': [{ buildingKey: 'b1', setting: { basis: 'per_m2', amountMinor: 1000, appliesTo: ['apartment'], active: true }, openingBalanceMinor: 3500000 }],
};

describe('runApply', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let base: string;
  let dir: string;

  const creds = (slug: string) => ({ slug, email: `owner@${slug}.mk`, password: 'correct-horse-1' });
  const get = (url: string) => t.app.inject({ method: 'GET', url, headers: { cookie: a.cookie } });

  beforeAll(async () => {
    t = await createTestApp();
    a = await registerTenant(t.app, 'firma-mig');
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;

    dir = await mkdtemp(join(tmpdir(), 'domexa-domar-'));
    for (const [name, data] of Object.entries(PLANS)) await writeFile(join(dir, name), JSON.stringify(data), 'utf8');
    await writeFile(join(dir, 'units-b1.csv'), UNITS_CSV, 'utf8');
  });
  afterAll(async () => { await t.close(); });

  it('refuses a remote target without --yes, before it logs in', async () => {
    await expect(runApply({ dir, baseUrl: 'https://domar.mk', ...creds('firma-mig'), log: () => {} }))
      .rejects.toThrow(/refusing to apply against https:\/\/domar\.mk/);
  });

  it('creates tax rates, services, the building, its units and its fund', async () => {
    const summary = await runApply({ dir, baseUrl: base, ...creds('firma-mig'), log: () => {} });
    expect(summary).toEqual({
      dryRun: false,
      taxRates: { created: 2, existing: 0 },
      services: { created: 1, existing: 0 },
      buildings: { created: 1, existing: 0 },
      units: { imported: 3, skipped: 0, contacts: 2, openingBalances: 2 },
      buildingServices: { created: 1, existing: 0 },
      reserveFund: { settings: 1, openingBalances: 1 },
    });

    // 4 tax rates come with a fresh mk tenant; the two Domexa ones are added by name.
    expect((await get('/api/tax-rates')).json().rows).toHaveLength(6);
    const services = (await get('/api/services')).json().rows;
    expect(services).toHaveLength(1);
    expect(services[0]).toMatchObject({ name: 'Чистење', pricing: 'fixed_per_unit', defaultPriceMinor: 30000, taxRateBp: 1800, appliesTo: ['apartment'] });

    const buildings = (await get('/api/buildings')).json().rows;
    expect(buildings).toHaveLength(1);
    const buildingId = buildings[0].id;
    expect(buildings[0]).toMatchObject({ name: 'Партизанска 12', city: 'Скопје', unitCount: 3 });

    const units = (await get(`/api/buildings/${buildingId}/units`)).json().rows;
    expect(units.map((u: { label: string }) => u.label).sort()).toEqual(['1', '2', 'P-1']);
    expect((await get('/api/contacts')).json().total).toBe(2);

    const balances = (await get(`/api/buildings/${buildingId}/opening-balances`)).json().rows;
    expect(balances.find((b: { lastName: string }) => b.lastName === 'Марков')).toMatchObject({ balanceMinor: 123456 });
    expect(balances.find((b: { lastName: string }) => b.lastName === 'Бошковска')).toMatchObject({ balanceMinor: -45050 });

    const bs = (await get(`/api/buildings/${buildingId}/services`)).json().rows;
    expect(bs).toHaveLength(1);
    expect(bs[0]).toMatchObject({ priceMinor: 35000, frequency: 'monthly', intervalMonths: 1, startsPeriod: '2026-01' });

    const fund = (await get(`/api/buildings/${buildingId}/reserve-fund`)).json();
    expect(fund.setting).toMatchObject({ basis: 'per_m2', amountMinor: 1000, appliesTo: ['apartment'], active: true });
    expect(fund.balanceMinor).toBe(3500000);
  });

  it('is idempotent: a second run creates nothing and books no second balance', async () => {
    const summary = await runApply({ dir, baseUrl: base, ...creds('firma-mig'), log: () => {} });
    expect(summary).toEqual({
      dryRun: false,
      taxRates: { created: 0, existing: 2 },
      services: { created: 0, existing: 1 },
      buildings: { created: 0, existing: 1 },
      units: { imported: 0, skipped: 3, contacts: 0, openingBalances: 0 },
      buildingServices: { created: 0, existing: 1 },
      reserveFund: { settings: 1, openingBalances: 0 },
    });

    expect((await get('/api/tax-rates')).json().rows).toHaveLength(6);
    expect((await get('/api/services')).json().rows).toHaveLength(1);
    const buildings = (await get('/api/buildings')).json().rows;
    expect(buildings).toHaveLength(1);
    expect(buildings[0].unitCount).toBe(3);
    expect((await get('/api/contacts')).json().total).toBe(2);
    expect((await get(`/api/buildings/${buildings[0].id}/reserve-fund`)).json().balanceMinor).toBe(3500000);
  });

  it('writes nothing at all in a dry run', async () => {
    const b = await registerTenant(t.app, 'firma-dry');
    const summary = await runApply({ dir, baseUrl: base, ...creds('firma-dry'), dryRun: true, log: () => {} });
    expect(summary.dryRun).toBe(true);
    expect(summary.taxRates).toEqual({ created: 2, existing: 0 });
    expect(summary.buildings).toEqual({ created: 1, existing: 0 });
    expect(summary.units).toEqual({ imported: 3, skipped: 0, contacts: 0, openingBalances: 0 });

    const dry = (url: string) => t.app.inject({ method: 'GET', url, headers: { cookie: b.cookie } });
    expect((await dry('/api/tax-rates')).json().rows).toHaveLength(4);
    expect((await dry('/api/services')).json().rows).toHaveLength(0);
    expect((await dry('/api/buildings')).json().rows).toHaveLength(0);
  });
});
