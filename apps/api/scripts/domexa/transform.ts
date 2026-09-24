import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildingKeyOf, DEFAULT_FIELD_MAP, domexaBuildingServicesToDomar, domexaBuildingsToDomar,
  domexaReserveFundToDomar, domexaServicesToDomar, domexaTaxRatesToDomar, domexaUnitsToImportRows,
  type DomexaFieldMap, type MigrationReport, mergeReports, reportToMarkdown, rowsToCanonicalCsv,
  separatorsFromOrganization,
} from '@domar/domain';

export interface TransformOptions {
  dir: string;
  /** The period a recurring service starts from when Domexa's row carries no start date. */
  fromPeriod: string;
  /** A JSON file overriding any subtree of DEFAULT_FIELD_MAP (docs/MIGRATION.md). */
  mapFile?: string;
  log?: (line: string) => void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const idOf = (v: unknown): string => (isRecord(v) && (typeof v.id === 'string' || typeof v.id === 'number') ? String(v.id) : '');

/** One level of subtree merging: `{ unit: { label: [...] } }` replaces only `unit.label`. */
function mergeMap(base: DomexaFieldMap, override: unknown): DomexaFieldMap {
  if (!isRecord(override)) return base;
  const out: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override)) {
    const current = out[k];
    out[k] = Array.isArray(v) || !isRecord(current) || !isRecord(v) ? v : { ...current, ...v };
  }
  return out as unknown as DomexaFieldMap;
}

export async function runTransform(o: TransformOptions): Promise<void> {
  const log = o.log ?? ((l: string) => console.log(l));
  const outDir = join(o.dir, 'domar');
  await mkdir(outDir, { recursive: true });

  const readJson = async <T>(name: string, fallback: T): Promise<T> => {
    try { return JSON.parse(await readFile(join(o.dir, name), 'utf8')) as T; } catch { log(`no ${name} in the export`); return fallback; }
  };
  const write = async (name: string, body: string): Promise<void> => {
    await writeFile(join(outDir, name), body, 'utf8');
    log(`wrote domar/${name}`);
  };
  const writeJson = (name: string, data: unknown) => write(name, `${JSON.stringify(data, null, 2)}\n`);

  const map = o.mapFile ? mergeMap(DEFAULT_FIELD_MAP, JSON.parse(await readFile(o.mapFile, 'utf8'))) : DEFAULT_FIELD_MAP;
  const organization = await readJson<unknown>('organization.json', null);
  const sep = separatorsFromOrganization(organization);
  const reports: MigrationReport[] = [];

  const taxRates = await readJson<unknown[]>('tax-rates.json', []);
  const tax = domexaTaxRatesToDomar(taxRates, sep);
  reports.push(tax.report);
  await writeJson('tax-rates.json', tax.rows);

  const rawServices = await readJson<unknown[]>('services.json', []);
  const services = domexaServicesToDomar(rawServices, taxRates, map, sep);
  reports.push(services.report);
  await writeJson('services.json', services.rows);
  const serviceNamesById: Record<string, string> = {};
  for (const s of rawServices) {
    const id = idOf(s);
    const name = isRecord(s) && typeof s.name === 'string' ? s.name : '';
    if (id && name) serviceNamesById[id] = name;
  }

  const rawBuildings = await readJson<unknown[]>('buildings.json', []);
  const buildings = domexaBuildingsToDomar(rawBuildings, map);
  reports.push(buildings.report);
  await writeJson('buildings.json', buildings.rows);

  const contacts = await readJson<unknown[]>('contacts.json', []);
  const contactsById: Record<string, unknown> = {};
  for (const c of contacts) { const id = idOf(c); if (id) contactsById[id] = c; }
  const statements = await readJson<Record<string, unknown>>('statements.json', {});
  const unitsByBuilding = await readJson<Record<string, unknown[]>>('units.json', {});
  const servicesByBuilding = await readJson<Record<string, unknown[]>>('building-services.json', {});
  const fundsByBuilding = await readJson<Record<string, unknown>>('reserve-funds.json', {});
  const fundBalances = await readJson<Record<string, unknown>>('reserve-fund-balances.json', {});

  const buildingServicePlans: unknown[] = [];
  const reserveFundPlans: unknown[] = [];
  for (const b of rawBuildings) {
    const id = idOf(b);
    if (!id) continue;
    const key = buildingKeyOf(id);

    const units = domexaUnitsToImportRows(unitsByBuilding[id] ?? [], contactsById, statements, map, sep);
    reports.push(units.report);
    await write(`units-${key}.csv`, rowsToCanonicalCsv(units.rows));

    const bs = domexaBuildingServicesToDomar(servicesByBuilding[id] ?? [], key, serviceNamesById, o.fromPeriod, map, sep);
    reports.push(bs.report);
    buildingServicePlans.push(...bs.rows);

    const fund = domexaReserveFundToDomar(key, fundsByBuilding[id] ?? null, fundBalances[id] ?? null, map, sep);
    reports.push(fund.report);
    reserveFundPlans.push(fund.plan);
  }
  await writeJson('building-services.json', buildingServicePlans);
  await writeJson('reserve-fund.json', reserveFundPlans);
  await writeJson('organization.json', organization);
  await write('report.md', reportToMarkdown(mergeReports(reports)));
}
