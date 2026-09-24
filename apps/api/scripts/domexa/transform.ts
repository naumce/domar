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

const isPathList = (v: unknown): v is string[] => Array.isArray(v) && v.every((p) => typeof p === 'string');

/**
 * One level of subtree merging: `{ unit: { label: [...] } }` replaces only `unit.label`. A section
 * or a leaf the default map does not know is reported and dropped — a typo in the map file must not
 * pass for a mapping that silently does nothing.
 */
function mergeMap(base: DomexaFieldMap, override: unknown, warn: (line: string) => void): DomexaFieldMap {
  if (!isRecord(override)) { warn('the --map file is not a JSON object; ignoring it'); return base; }
  const known = base as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...known };
  for (const [k, v] of Object.entries(override)) {
    const current = known[k];
    if (current === undefined) { warn(`--map: unknown section "${k}"; ignoring it`); continue; }
    if (Array.isArray(current)) {
      if (!isPathList(v)) { warn(`--map: "${k}" must be an array of field paths; ignoring it`); continue; }
      out[k] = v;
      continue;
    }
    if (!isRecord(v)) { warn(`--map: "${k}" must be an object of field paths; ignoring it`); continue; }
    const section: Record<string, unknown> = { ...(current as Record<string, unknown>) };
    for (const [leaf, paths] of Object.entries(v)) {
      if (!(leaf in section)) { warn(`--map: unknown field "${k}.${leaf}"; ignoring it`); continue; }
      if (!isPathList(paths)) { warn(`--map: "${k}.${leaf}" must be an array of field paths; ignoring it`); continue; }
      section[leaf] = paths;
    }
    out[k] = section;
  }
  return out as unknown as DomexaFieldMap;
}

export async function runTransform(o: TransformOptions): Promise<void> {
  const log = o.log ?? ((l: string) => console.log(l));
  const outDir = join(o.dir, 'domar');
  await mkdir(outDir, { recursive: true });

  /** A missing file is a fallback; anything else — a permission error, broken JSON — is fatal. */
  const readJson = async <T>(name: string, fallback: T): Promise<T> => {
    const path = join(o.dir, name);
    let body: string;
    try {
      body = await readFile(path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') { log(`no ${name} in the export`); return fallback; }
      throw new Error(`cannot read ${path}: ${(e as Error).message}`);
    }
    try { return JSON.parse(body) as T; } catch (e) { throw new Error(`${path} is not valid JSON: ${(e as Error).message}`); }
  };
  const write = async (name: string, body: string): Promise<void> => {
    await writeFile(join(outDir, name), body, 'utf8');
    log(`wrote domar/${name}`);
  };
  const writeJson = (name: string, data: unknown) => write(name, `${JSON.stringify(data, null, 2)}\n`);

  let map = DEFAULT_FIELD_MAP;
  if (o.mapFile) {
    const body = await readFile(o.mapFile, 'utf8');
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch (e) { throw new Error(`${o.mapFile} is not valid JSON: ${(e as Error).message}`); }
    map = mergeMap(DEFAULT_FIELD_MAP, parsed, log);
  }
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
  const idByKey = new Map<string, string>();
  for (const b of rawBuildings) {
    const id = idOf(b);
    if (!id) continue;
    const key = buildingKeyOf(id);
    // The key names the CSV and ties it to the JSON plans, so a collision would merge two buildings.
    const taken = idByKey.get(key);
    if (taken !== undefined) throw new Error(`buildings ${taken} and ${id} both become the key "${key}"; give them distinct ids before transforming`);
    idByKey.set(key, id);

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
