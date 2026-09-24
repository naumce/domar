import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runTransform } from '../scripts/domexa/transform.js';

const RAW = {
  'organization.json': { id: 1, name: 'Test kompanija', thousandSeparator: '.', decimalSeparator: ',' },
  'tax-rates.json': [
    { id: 'tr-0', name: '/', rate: '0.00', isDefault: false },
    { id: 'tr-18', name: 'ДДВ', rate: '18.00', isDefault: true },
  ],
  'services.json': [{ id: 's1', name: 'Чистење', categoryName: 'Чистење', pricingModel: 'fixed_per_unit', price: '300.00', taxRateId: 'tr-18', appliesTo: ['apartment'], isRecurring: true }],
  'contacts.json': [{ id: 'c1', firstName: 'Марко', lastName: 'Марков', email: 'marko@example.mk', phone: '070111222' }],
  'statements.json': { c1: { closingBalance: '1234.56' } },
  'buildings.json': [{ id: 'b1', name: 'Партизанска 12', address: 'Партизанска 12', city: 'Скопје', postalCode: '1000' }],
  'units.json': { b1: [{ id: 'u1', number: '1', floor: '1', type: 'apartment', areaM2: 54.5, ownerContactId: 'c1' }] },
  'building-services.json': { b1: [{ id: 'bs1', serviceId: 's1', price: '350.00', intervalMonths: 1, startsAt: '2026-01-01' }] },
  'reserve-funds.json': { b1: { basis: 'per_m2', amount: '10.00', appliesTo: ['apartment'], isActive: true } },
  'reserve-fund-balances.json': { b1: { balance: '35000.00' } },
};

describe('runTransform', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'domexa-raw-'));
    for (const [name, data] of Object.entries(RAW)) await writeFile(join(dir, name), JSON.stringify(data), 'utf8');
    await runTransform({ dir, fromPeriod: '2026-09', log: () => {} });
  });

  const read = (name: string) => readFile(join(dir, 'domar', name), 'utf8');

  it('writes the canonical units CSV per building', async () => {
    expect(await read('units-b1.csv')).toBe(
      'број;кат;тип;површина;удел;име;презиме;е-пошта;телефон;почетно салдо\n'
      + '1;1;apartment;54.5;;Марко;Марков;marko@example.mk;070111222;1234.56\n',
    );
  });

  it('writes the plans the apply step reads, with names instead of ids', async () => {
    expect(JSON.parse(await read('tax-rates.json'))).toEqual([
      { name: '/', rateBp: 0, isDefault: false },
      { name: 'ДДВ', rateBp: 1800, isDefault: true },
    ]);
    expect(JSON.parse(await read('services.json'))).toEqual([
      { name: 'Чистење', category: 'Чистење', description: null, pricing: 'fixed_per_unit', defaultPriceMinor: 30000, taxRateName: 'ДДВ', appliesTo: ['apartment'], recurring: true },
    ]);
    expect(JSON.parse(await read('buildings.json'))).toEqual([
      { key: 'b1', name: 'Партизанска 12', address: 'Партизанска 12', city: 'Скопје', postalCode: '1000' },
    ]);
    expect(JSON.parse(await read('building-services.json'))).toEqual([
      { buildingKey: 'b1', serviceName: 'Чистење', priceMinor: 35000, pricing: null, frequency: 'monthly', intervalMonths: 1, startsPeriod: '2026-01', endsPeriod: null },
    ]);
    expect(JSON.parse(await read('reserve-fund.json'))).toEqual([
      { buildingKey: 'b1', setting: { basis: 'per_m2', amountMinor: 1000, appliesTo: ['apartment'], active: true }, openingBalanceMinor: 3500000 },
    ]);
  });

  it('writes a report with the counts and no credential in it', async () => {
    const md = await read('report.md');
    expect(md).toContain('# Domexa migration report');
    expect(md).toContain('- units: 1');
    expect(md).toContain('- buildings: 1');
    expect(md).toContain('- taxRates: 2');
  });

  it('applies an override map file', async () => {
    const other = await mkdtemp(join(tmpdir(), 'domexa-raw-'));
    for (const [name, data] of Object.entries(RAW)) await writeFile(join(other, name), JSON.stringify(data), 'utf8');
    await writeFile(join(other, 'units.json'), JSON.stringify({ b1: [{ id: 'u1', broj: '7', type: 'стан' }] }), 'utf8');
    const mapFile = join(other, 'map.json');
    await writeFile(mapFile, JSON.stringify({ unit: { label: ['broj'] } }), 'utf8');

    await runTransform({ dir: other, fromPeriod: '2026-09', mapFile, log: () => {} });
    expect(await readFile(join(other, 'domar', 'units-b1.csv'), 'utf8')).toContain('\n7;;apartment;');
  });

  it('survives a folder with nothing but buildings in it', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'domexa-raw-'));
    await writeFile(join(bare, 'buildings.json'), JSON.stringify([{ id: 'b9', name: 'Само зграда' }]), 'utf8');
    await runTransform({ dir: bare, fromPeriod: '2026-09', log: () => {} });
    expect(JSON.parse(await readFile(join(bare, 'domar', 'services.json'), 'utf8'))).toEqual([]);
    expect(await readFile(join(bare, 'domar', 'units-b9.csv'), 'utf8')).toBe('број;кат;тип;површина;удел;име;презиме;е-пошта;телефон;почетно салдо\n');
  });

  it('copies the organization row through for the operator to retype into Settings', async () => {
    expect(JSON.parse(await read('organization.json'))).toMatchObject({ name: 'Test kompanija', decimalSeparator: ',' });
  });

  it('fails on a broken export file instead of treating it as a missing one', async () => {
    const bad = await mkdtemp(join(tmpdir(), 'domexa-raw-'));
    await writeFile(join(bad, 'buildings.json'), '[{"id": "b1",', 'utf8');
    await expect(runTransform({ dir: bad, fromPeriod: '2026-09', log: () => {} }))
      .rejects.toThrow(/buildings\.json is not valid JSON/);
  });

  it('fails when two building ids would share one key', async () => {
    const clash = await mkdtemp(join(tmpdir(), 'domexa-raw-'));
    await writeFile(join(clash, 'buildings.json'), JSON.stringify([{ id: 'A 1', name: 'Прва' }, { id: 'A/1', name: 'Втора' }]), 'utf8');
    await expect(runTransform({ dir: clash, fromPeriod: '2026-09', log: () => {} }))
      .rejects.toThrow(/buildings A 1 and A\/1 both become the key "a-1"/);
  });

  it('warns about an unknown map section and an override that is not a list of paths', async () => {
    const mapped = await mkdtemp(join(tmpdir(), 'domexa-raw-'));
    await writeFile(join(mapped, 'buildings.json'), JSON.stringify([{ id: 'b1', naziv: 'Прва' }]), 'utf8');
    const mapFile = join(mapped, 'map.json');
    await writeFile(mapFile, JSON.stringify({ zgrada: { name: ['naziv'] }, building: { name: ['naziv'], nope: ['x'], city: 'grad' } }), 'utf8');

    const lines: string[] = [];
    await runTransform({ dir: mapped, fromPeriod: '2026-09', mapFile, log: (l) => lines.push(l) });
    expect(lines).toContain('--map: unknown section "zgrada"; ignoring it');
    expect(lines).toContain('--map: unknown field "building.nope"; ignoring it');
    expect(lines).toContain('--map: "building.city" must be an array of field paths; ignoring it');
    // The one good override still applied.
    expect(JSON.parse(await readFile(join(mapped, 'domar', 'buildings.json'), 'utf8'))).toEqual([
      { key: 'b1', name: 'Прва', address: '', city: '', postalCode: '' },
    ]);
  });
});
