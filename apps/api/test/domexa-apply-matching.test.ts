import { mkdtemp, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runApply } from '../scripts/domexa/apply.js';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

const HEADER = 'број;кат;тип;површина;удел;име;презиме;е-пошта;телефон;почетно салдо\n';
const unitsCsv = (...lines: string[]) => HEADER + lines.map((l) => `${l}\n`).join('');

/** A folder of plan files, as `transform` would have written it. */
async function planDir(files: Record<string, unknown | string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'domexa-plan-'));
  for (const [name, data] of Object.entries(files)) {
    await writeFile(join(dir, name), typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
  }
  return dir;
}

describe('runApply matching and reporting', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let base: string;

  const creds = (slug: string) => ({ slug, email: `owner@${slug}.mk`, password: 'correct-horse-1' });
  const apply = (dir: string, slug: string) => runApply({ dir, baseUrl: base, ...creds(slug), log: () => {} });

  beforeAll(async () => {
    t = await createTestApp();
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await t.close(); });

  const as = (cookie: string) => ({
    get: (url: string) => t.app.inject({ method: 'GET', url, headers: { cookie } }),
    post: (url: string, payload: Record<string, unknown>) => t.app.inject({ method: 'POST', url, payload, headers: { cookie } }),
  });

  it('gives a clashing tax-rate name its own rate and leaves the tenant default alone', async () => {
    const a = await registerTenant(t.app, 'firma-rate');
    const api = as(a.cookie);
    await api.post('/api/tax-rates', { name: 'ДДВ', rateBp: 500 });

    const dir = await planDir({
      'tax-rates.json': [
        { name: 'ДДВ', rateBp: 1800, isDefault: true },
        { name: 'ДДВ 18%', rateBp: 1800, isDefault: false },
        { name: '/', rateBp: 0, isDefault: false },
      ],
    });
    const summary = await apply(dir, 'firma-rate');
    expect(summary.taxRates).toEqual({ created: 2, existing: 1 });

    const rows = (await api.get('/api/tax-rates')).json().rows as { name: string; rateBp: number; isDefault: boolean }[];
    expect(rows.find((r) => r.name === 'ДДВ (18%)')).toMatchObject({ rateBp: 1800, isDefault: false });
    expect(rows.find((r) => r.name === 'ДДВ')).toMatchObject({ rateBp: 500 });
    expect(rows.find((r) => r.isDefault)).toMatchObject({ name: 'ДДВ 18%' });
  });

  it('does not reuse a building that only shares its name', async () => {
    const a = await registerTenant(t.app, 'firma-addr');
    const api = as(a.cookie);
    await api.post('/api/buildings', { name: 'Партизанска 12', address: 'Друга 5', city: 'Скопје', postalCode: '1000' });

    const dir = await planDir({
      'buildings.json': [{ key: 'b1', name: 'Партизанска 12', address: 'Партизанска 12', city: 'Скопје', postalCode: '1000' }],
    });
    const summary = await apply(dir, 'firma-addr');
    expect(summary.buildings).toEqual({ created: 1, existing: 0 });
    expect(summary.units.missingCsv).toBe(1);

    const rows = (await api.get('/api/buildings')).json().rows as { address: string }[];
    expect(rows.map((r) => r.address).sort()).toEqual(['Друга 5', 'Партизанска 12']);
  });

  it('refuses to guess when the tenant already has two buildings that match', async () => {
    const a = await registerTenant(t.app, 'firma-amb');
    const api = as(a.cookie);
    const payload = { name: 'Иста 1', address: 'Иста 1', city: 'Скопје', postalCode: '1000' };
    await api.post('/api/buildings', payload);
    await api.post('/api/buildings', payload);

    const dir = await planDir({ 'buildings.json': [{ key: 'b1', ...payload }] });
    await expect(apply(dir, 'firma-amb')).rejects.toThrow(/more than one building matching b1/);
    expect((await api.get('/api/buildings')).json().rows).toHaveLength(2);
  });

  it('refuses a plan whose rows are the same building, before it logs in', async () => {
    const row = { name: 'Дупла', address: 'Прва 1', city: 'Скопје', postalCode: '1000' };
    const dir = await planDir({ 'buildings.json': [{ key: 'b1', ...row }, { key: 'b2', ...row }] });
    await expect(apply(dir, 'firma-amb')).rejects.toThrow(/same building by name, address and city: b1 \+ b2/);
  });

  it('keeps two same-named buildings apart across runs', async () => {
    const a = await registerTenant(t.app, 'firma-two');
    const api = as(a.cookie);
    const dir = await planDir({
      'buildings.json': [
        { key: 'b1', name: 'Иста', address: 'Прва 1', city: 'Скопје', postalCode: '1000' },
        { key: 'b2', name: 'Иста', address: 'Втора 2', city: 'Скопје', postalCode: '1000' },
      ],
      'units-b1.csv': unitsCsv('1;1;apartment;54.5;;Марко;Марков;marko@example.mk;070111222;0'),
      'units-b2.csv': unitsCsv('X1;1;apartment;62;;Ана;Бошковска;ana@example.mk;070222333;0'),
    });

    const first = await apply(dir, 'firma-two');
    expect(first.buildings).toEqual({ created: 2, existing: 0 });
    expect(first.units).toMatchObject({ imported: 2, skipped: 0, missingCsv: 0 });

    const second = await apply(dir, 'firma-two');
    expect(second.buildings).toEqual({ created: 0, existing: 2 });
    expect(second.units).toMatchObject({ imported: 0, skipped: 2, conflicts: ['b1:1', 'b2:X1'] });

    const rows = (await api.get('/api/buildings')).json().rows as { id: string; address: string; unitCount: number }[];
    expect(rows).toHaveLength(2);
    for (const b of rows) expect(b.unitCount).toBe(1);
    const labelsOf = async (id: string) => ((await api.get(`/api/buildings/${id}/units`)).json().rows as { label: string }[]).map((u) => u.label);
    expect(await labelsOf(rows.find((b) => b.address === 'Прва 1')!.id)).toEqual(['1']);
    expect(await labelsOf(rows.find((b) => b.address === 'Втора 2')!.id)).toEqual(['X1']);
  });

  it('reports the rows the import rejected, a missing CSV and a doubled building service', async () => {
    await registerTenant(t.app, 'firma-msg');
    const dir = await planDir({
      'services.json': [{ name: 'Чистење', category: null, description: null, pricing: 'fixed_per_unit', defaultPriceMinor: 30000, taxRateName: null, appliesTo: ['apartment'], recurring: true }],
      'buildings.json': [
        { key: 'b1', name: 'Прва', address: 'Прва 1', city: 'Скопје', postalCode: '1000' },
        { key: 'b2', name: 'Втора', address: 'Втора 2', city: 'Скопје', postalCode: '1000' },
      ],
      'units-b1.csv': unitsCsv(
        '1;1;apartment;54.5;;Марко;Марков;marko@example.mk;070111222;0',
        '9;;нешто;;;;;;;',
      ),
      'building-services.json': [
        { buildingKey: 'b1', serviceName: 'Чистење', priceMinor: 35000, pricing: null, frequency: 'monthly', intervalMonths: 1, startsPeriod: '2026-01', endsPeriod: null },
        { buildingKey: 'b1', serviceName: 'Чистење', priceMinor: 40000, pricing: null, frequency: 'monthly', intervalMonths: 1, startsPeriod: '2026-02', endsPeriod: null },
      ],
    });

    const summary = await apply(dir, 'firma-msg');
    expect(summary.units.imported).toBe(1);
    expect(summary.units.errors).toEqual([{ line: 3, message: 'unknown kind: нешто' }]);
    expect(summary.units.missingCsv).toBe(1);
    expect(summary.buildingServices).toEqual({ created: 1, existing: 0, duplicates: 1 });
  });
});
