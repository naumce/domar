import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ApplyOptions {
  dir: string;
  baseUrl: string;
  slug: string;
  email: string;
  password: string;
  dryRun?: boolean;
  /** Required for any target that is not localhost (spec §20.4). */
  yes?: boolean;
  /** Overwrite a reserve fund setting the tenant already has; off, the existing one is kept. */
  forceSettings?: boolean;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

/**
 * What the run did. In a dry run `created` counts what *would* be created; `units.estimated` is the
 * part of `units.imported` that is a plain line count because the building does not exist yet and
 * the import route had nothing to preview against.
 */
export interface ApplySummary {
  dryRun: boolean;
  taxRates: { created: number; existing: number };
  services: { created: number; existing: number };
  buildings: { created: number; existing: number };
  units: {
    imported: number; skipped: number; contacts: number; openingBalances: number;
    estimated: number; missingCsv: number;
    errors: { line: number; message: string }[];
    conflicts: string[];
  };
  buildingServices: { created: number; existing: number; duplicates: number };
  reserveFund: { settings: { written: number; kept: number }; openingBalances: number };
}

export class DomarApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly path: string, message: string) {
    super(`${path} → ${status} ${code}: ${message}`);
    this.name = 'DomarApiError';
  }
}

const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

class DomarApi {
  private cookie = '';

  constructor(
    private readonly base: string,
    private readonly fetchImpl: typeof fetch,
    private readonly log: (line: string) => void,
    private readonly dryRun: boolean,
  ) {}

  async login(slug: string, email: string, password: string): Promise<void> {
    const res = await this.send('POST', '/api/auth/login', { tenantSlug: slug, email, password });
    const set = res.headers.getSetCookie?.() ?? [];
    this.cookie = (set[0] ?? res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    if (!this.cookie) throw new Error('the domar login returned no session cookie');
  }

  async get<T>(path: string): Promise<T> {
    return (await (await this.send('GET', path)).json()) as T;
  }

  /** A write; in a dry run it is logged, skipped, and the caller gets null. */
  async write<T>(method: 'POST' | 'PUT', path: string, body: unknown): Promise<T | null> {
    if (this.dryRun) { this.log(`DRY ${method} ${path}`); return null; }
    return (await (await this.send(method, path, body)).json()) as T;
  }

  /** A POST whose own body carries `dryRun`, so the server — not this class — decides to write. */
  async call<T>(path: string, body: unknown): Promise<T> {
    return (await (await this.send('POST', path, body)).json()) as T;
  }

  private async send(method: string, path: string, body?: unknown): Promise<Response> {
    this.log(`${method} ${path}`); // method and path only — never a body, a cookie or a password
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text();
      let code = 'error';
      let message = text.slice(0, 300);
      try {
        const e = (JSON.parse(text) as { error?: { code?: string; message?: string } }).error;
        code = e?.code ?? code;
        message = e?.message ?? message;
      } catch { /* not our envelope; keep the raw text */ }
      throw new DomarApiError(res.status, code, path, message);
    }
    return res;
  }
}

interface TaxRatePlan { name: string; rateBp: number; isDefault: boolean }
interface ServicePlan { name: string; category: string | null; description: string | null; pricing: string; defaultPriceMinor: number; taxRateName: string | null; appliesTo: string[]; recurring: boolean }
interface BuildingPlan { key: string; name: string; address: string; city: string; postalCode: string }
interface BuildingServicePlan { buildingKey: string; serviceName: string; priceMinor: number | null; pricing: string | null; frequency: string; intervalMonths: number; startsPeriod: string; endsPeriod: string | null }
interface ReserveFundPlan { buildingKey: string; setting: { basis: string; amountMinor: number; appliesTo: string[]; active: boolean } | null; openingBalanceMinor: number }

interface ImportResult {
  errors: { line: number; message: string }[];
  conflicts: string[];
  counts: { units: number; newContacts: number; openingBalances: number; conflicts: number };
}

const emptySummary = (dryRun: boolean): ApplySummary => ({
  dryRun,
  taxRates: { created: 0, existing: 0 },
  services: { created: 0, existing: 0 },
  buildings: { created: 0, existing: 0 },
  units: { imported: 0, skipped: 0, contacts: 0, openingBalances: 0, estimated: 0, missingCsv: 0, errors: [], conflicts: [] },
  buildingServices: { created: 0, existing: 0, duplicates: 0 },
  reserveFund: { settings: { written: 0, kept: 0 }, openingBalances: 0 },
});

/** `1800` reads as `18%`, `1850` as `18.5%` — what the operator sees in the new rate's name. */
function percentOf(rateBp: number): string {
  return `${(rateBp / 100).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')}%`;
}

const norm = (v: string): string => v.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** Two buildings are the same one only when name, address and city all agree. */
const buildingMatchKey = (b: { name: string; address?: string; city?: string }): string =>
  [norm(b.name), norm(b.address ?? ''), norm(b.city ?? '')].join(' | ');

/** A missing file is a missing step; a broken one is fatal, named by its path. */
async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`cannot read ${path}: ${(e as Error).message}`);
  }
}

/**
 * Posts a transformed export into a domar tenant through domar's own API — every route already
 * carries the tenant filter, the role check and the audit row. Idempotent by name/label
 * (design addendum 18), so a second run creates nothing.
 */
export async function runApply(o: ApplyOptions): Promise<ApplySummary> {
  const log = o.log ?? ((l: string) => console.log(l));
  const dryRun = o.dryRun === true;
  const base = o.baseUrl.replace(/\/$/, '');
  if (!LOCAL.test(base) && o.yes !== true) {
    throw new Error(`refusing to apply against ${base} without --yes (spec §20.4)`);
  }

  const api = new DomarApi(base, o.fetchImpl ?? fetch, log, dryRun);
  const summary = emptySummary(dryRun);
  try {
    await apply(api, o, summary, log, dryRun);
  } catch (e) {
    log(`the run stopped at: ${JSON.stringify(summary)}`);
    throw e;
  }
  return summary;
}

async function apply(api: DomarApi, o: ApplyOptions, summary: ApplySummary, log: (line: string) => void, dryRun: boolean): Promise<void> {
  const plan = async <T>(name: string): Promise<T[]> => {
    const path = join(o.dir, name);
    const body = await readTextOrNull(path);
    if (body === null) { log(`no ${name}, skipping that step`); return []; }
    try { return JSON.parse(body) as T[]; } catch (e) { throw new Error(`${path} is not valid JSON: ${(e as Error).message}`); }
  };

  // Every plan file is read — and every plan-internal clash refused — before a single request.
  const taxRatePlans = await plan<TaxRatePlan>('tax-rates.json');
  const servicePlans = await plan<ServicePlan>('services.json');
  const buildingPlans = await plan<BuildingPlan>('buildings.json');
  const bsPlans = await plan<BuildingServicePlan>('building-services.json');
  const fundPlans = await plan<ReserveFundPlan>('reserve-fund.json');

  const plannedByMatch = new Map<string, string[]>();
  for (const p of buildingPlans) {
    const keys = plannedByMatch.get(buildingMatchKey(p)) ?? [];
    keys.push(p.key);
    plannedByMatch.set(buildingMatchKey(p), keys);
  }
  const clashing = [...plannedByMatch.values()].filter((keys) => keys.length > 1);
  if (clashing.length > 0) {
    throw new Error(`buildings.json has rows that are the same building by name, address and city: ${clashing.map((keys) => keys.join(' + ')).join('; ')}; separate them before applying`);
  }

  await api.login(o.slug, o.email, o.password);

  // Existing buildings are matched before anything is written, so an ambiguous tenant stops the run.
  const existingByMatch = new Map<string, string[]>();
  for (const b of (await api.get<{ rows: { id: string; name: string; address: string; city: string }[] }>('/api/buildings')).rows) {
    const key = buildingMatchKey(b);
    existingByMatch.set(key, [...(existingByMatch.get(key) ?? []), b.id]);
  }
  const ambiguous = buildingPlans.filter((p) => (existingByMatch.get(buildingMatchKey(p)) ?? []).length > 1);
  if (ambiguous.length > 0) {
    throw new Error(`the tenant already has more than one building matching ${ambiguous.map((p) => p.key).join(', ')}; merge them by hand before applying`);
  }

  // 1. tax rates, by name *and* rate — a name that carries another rate gets a rate of its own
  const taxRateIds = new Map<string, string>();
  const rates = (await api.get<{ rows: { id: string; name: string; rateBp: number; isDefault: boolean; isActive: boolean }[] }>('/api/tax-rates?includeInactive=true'))
    .rows.filter((r) => r.isActive !== false);
  let hasDefault = rates.some((r) => r.isDefault);
  for (const p of taxRatePlans) {
    const same = rates.find((r) => norm(r.name) === norm(p.name) && r.rateBp === p.rateBp);
    if (same) { summary.taxRates.existing++; taxRateIds.set(p.name, same.id); continue; }
    const clash = rates.find((r) => norm(r.name) === norm(p.name));
    const name = (clash ? `${p.name} (${percentOf(p.rateBp)})` : p.name).slice(0, 100);
    if (clash) log(`a tax rate named ${p.name} already exists at ${percentOf(clash.rateBp)}; creating "${name}" instead`);
    const isDefault = p.isDefault === true && !hasDefault;
    if (p.isDefault === true && hasDefault) log(`the tenant already has a default tax rate; "${name}" is created without it`);
    summary.taxRates.created++;
    const created = await api.write<{ id: string }>('POST', '/api/tax-rates', { name, rateBp: p.rateBp, isDefault });
    if (isDefault) hasDefault = true;
    if (created) taxRateIds.set(p.name, created.id);
  }

  // 2. services, by name
  const serviceIds = new Map<string, string>();
  const services = (await api.get<{ rows: { id: string; name: string; isActive: boolean }[] }>('/api/services?includeInactive=true'))
    .rows.filter((s) => s.isActive !== false);
  for (const s of services) serviceIds.set(norm(s.name), s.id);
  for (const p of servicePlans) {
    if (serviceIds.has(norm(p.name))) { summary.services.existing++; continue; }
    summary.services.created++;
    const taxRateId = p.taxRateName ? taxRateIds.get(p.taxRateName) : undefined;
    const created = await api.write<{ id: string }>('POST', '/api/services', {
      name: p.name, category: p.category, description: p.description, pricing: p.pricing,
      defaultPriceMinor: p.defaultPriceMinor, appliesTo: p.appliesTo, recurring: p.recurring,
      ...(taxRateId ? { taxRateId } : {}),
    });
    if (created) serviceIds.set(norm(p.name), created.id);
  }

  // 3. buildings, by name + address + city — then their units, services and fund
  const buildingIdByKey = new Map<string, string>();
  for (const p of buildingPlans) {
    const existing = (existingByMatch.get(buildingMatchKey(p)) ?? [])[0];
    if (existing) { summary.buildings.existing++; buildingIdByKey.set(p.key, existing); continue; }
    summary.buildings.created++;
    const created = await api.write<{ id: string }>('POST', '/api/buildings', { name: p.name, address: p.address, city: p.city, postalCode: p.postalCode });
    if (created) buildingIdByKey.set(p.key, created.id);
  }

  // `mode: 'skip'` is what makes a second run import nothing: every existing label is a conflict.
  for (const p of buildingPlans) {
    const path = join(o.dir, `units-${p.key}.csv`);
    const content = await readTextOrNull(path);
    if (content === null || !content.trim()) {
      summary.units.missingCsv++;
      log(`no units for ${p.key}: ${content === null ? `${path} is missing` : `${path} is empty`}`);
      continue;
    }
    const buildingId = buildingIdByKey.get(p.key);
    if (!buildingId) {
      // Dry run against a building that does not exist yet: nothing to preview, so count the rows.
      const rows = content.trim().split(/\r?\n/).length - 1;
      log(`DRY ${rows} rows estimated for ${p.name} — the building does not exist yet, so they were not previewed`);
      summary.units.imported += rows;
      summary.units.estimated += rows;
      continue;
    }
    const result = await api.call<ImportResult>(`/api/buildings/${buildingId}/import/units`, { content, mode: 'skip', dryRun });
    summary.units.imported += result.counts.units;
    summary.units.skipped += result.counts.conflicts;
    summary.units.contacts += result.counts.newContacts;
    summary.units.openingBalances += result.counts.openingBalances;
    for (const e of result.errors) {
      summary.units.errors.push(e);
      log(`units-${p.key}.csv line ${e.line}: ${e.message}`);
    }
    if (result.conflicts.length > 0) {
      for (const label of result.conflicts) summary.units.conflicts.push(`${p.key}:${label}`);
      log(`${p.key}: ${result.conflicts.length} unit labels already exist and were skipped: ${result.conflicts.join(', ')}`);
    }
  }

  for (const key of new Set(bsPlans.map((p) => p.buildingKey))) {
    if (!buildingIdByKey.has(key)) log(`building ${key} does not exist yet; its services were not applied`);
  }
  for (const [key, buildingId] of buildingIdByKey) {
    const mine = bsPlans.filter((p) => p.buildingKey === key);
    if (mine.length === 0) continue;
    const attached = new Set((await api.get<{ rows: { serviceId: string }[] }>(`/api/buildings/${buildingId}/services`)).rows.map((r) => r.serviceId));
    const planned = new Set<string>();
    for (const p of mine) {
      const serviceId = serviceIds.get(norm(p.serviceName));
      if (!serviceId) { log(`no service named ${p.serviceName}; skipping its building service`); continue; }
      if (planned.has(serviceId)) {
        summary.buildingServices.duplicates++;
        log(`building ${key}: ${p.serviceName} is planned more than once; only the first row is attached`);
        continue;
      }
      planned.add(serviceId);
      if (attached.has(serviceId)) { summary.buildingServices.existing++; continue; }
      summary.buildingServices.created++;
      await api.write('POST', `/api/buildings/${buildingId}/services`, {
        serviceId, frequency: p.frequency, intervalMonths: p.intervalMonths, startsPeriod: p.startsPeriod, endsPeriod: p.endsPeriod,
        ...(p.priceMinor !== null ? { priceMinor: p.priceMinor } : {}),
        ...(p.pricing !== null ? { pricing: p.pricing } : {}),
      });
      attached.add(serviceId);
    }
  }

  for (const p of fundPlans) {
    const buildingId = buildingIdByKey.get(p.buildingKey);
    if (!buildingId) { log(`building ${p.buildingKey} does not exist yet; its reserve fund was not previewed`); continue; }
    // The real state decides both writes: a setting is never overwritten and a balance never doubled.
    const state = await api.get<{ setting: unknown; balanceMinor: number }>(`/api/buildings/${buildingId}/reserve-fund`);
    if (p.setting) {
      if (state.setting === null || o.forceSettings === true) {
        summary.reserveFund.settings.written++;
        await api.write('PUT', `/api/buildings/${buildingId}/reserve-fund`, p.setting);
      } else {
        summary.reserveFund.settings.kept++;
        log(`building ${p.buildingKey} already has a reserve fund setting; keeping it (pass --force-settings to overwrite)`);
      }
    }
    if (p.openingBalanceMinor === 0) continue;
    // The opening balance is a posting, so it may only be booked into an empty fund.
    if (state.balanceMinor !== 0) { log(`the reserve fund of ${p.buildingKey} is not empty; leaving its balance alone`); continue; }
    summary.reserveFund.openingBalances++;
    await api.write('POST', `/api/buildings/${buildingId}/reserve-fund/opening-balance`, { amountMinor: p.openingBalanceMinor, note: 'Domexa migration' });
  }
}
