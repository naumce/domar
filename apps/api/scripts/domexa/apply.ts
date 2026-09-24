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
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

/**
 * What the run did. In a dry run `created` counts what *would* be created, and `units.imported` is
 * the number of data rows in the CSV: no preview is requested for a building that does not exist.
 */
export interface ApplySummary {
  dryRun: boolean;
  taxRates: { created: number; existing: number };
  services: { created: number; existing: number };
  buildings: { created: number; existing: number };
  units: { imported: number; skipped: number; contacts: number; openingBalances: number };
  buildingServices: { created: number; existing: number };
  reserveFund: { settings: number; openingBalances: number };
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
  const summary: ApplySummary = {
    dryRun,
    taxRates: { created: 0, existing: 0 },
    services: { created: 0, existing: 0 },
    buildings: { created: 0, existing: 0 },
    units: { imported: 0, skipped: 0, contacts: 0, openingBalances: 0 },
    buildingServices: { created: 0, existing: 0 },
    reserveFund: { settings: 0, openingBalances: 0 },
  };
  const plan = async <T>(name: string): Promise<T[]> => {
    try { return JSON.parse(await readFile(join(o.dir, name), 'utf8')) as T[]; } catch { log(`no ${name}, skipping that step`); return []; }
  };

  await api.login(o.slug, o.email, o.password);

  // 1. tax rates, by name
  const taxRateIds = new Map<string, string>();
  for (const r of (await api.get<{ rows: { id: string; name: string }[] }>('/api/tax-rates?includeInactive=true')).rows) taxRateIds.set(r.name, r.id);
  for (const p of await plan<TaxRatePlan>('tax-rates.json')) {
    if (taxRateIds.has(p.name)) { summary.taxRates.existing++; continue; }
    summary.taxRates.created++;
    const created = await api.write<{ id: string }>('POST', '/api/tax-rates', { name: p.name, rateBp: p.rateBp, isDefault: p.isDefault });
    if (created) taxRateIds.set(p.name, created.id);
  }

  // 2. services, by name
  const serviceIds = new Map<string, string>();
  for (const s of (await api.get<{ rows: { id: string; name: string }[] }>('/api/services?includeInactive=true')).rows) serviceIds.set(s.name, s.id);
  for (const p of await plan<ServicePlan>('services.json')) {
    if (serviceIds.has(p.name)) { summary.services.existing++; continue; }
    summary.services.created++;
    const taxRateId = p.taxRateName ? taxRateIds.get(p.taxRateName) : undefined;
    const created = await api.write<{ id: string }>('POST', '/api/services', {
      name: p.name, category: p.category, description: p.description, pricing: p.pricing,
      defaultPriceMinor: p.defaultPriceMinor, appliesTo: p.appliesTo, recurring: p.recurring,
      ...(taxRateId ? { taxRateId } : {}),
    });
    if (created) serviceIds.set(p.name, created.id);
  }

  // 3. buildings, by name — then their units, services and fund
  const buildingIds = new Map<string, string>();
  for (const b of (await api.get<{ rows: { id: string; name: string }[] }>('/api/buildings')).rows) buildingIds.set(b.name, b.id);
  const buildingIdByKey = new Map<string, string>();
  const buildingPlans = await plan<BuildingPlan>('buildings.json');
  for (const p of buildingPlans) {
    const existing = buildingIds.get(p.name);
    if (existing) { summary.buildings.existing++; buildingIdByKey.set(p.key, existing); continue; }
    summary.buildings.created++;
    const created = await api.write<{ id: string }>('POST', '/api/buildings', { name: p.name, address: p.address, city: p.city, postalCode: p.postalCode });
    if (created) buildingIdByKey.set(p.key, created.id);
  }

  // `mode: 'skip'` is what makes a second run import nothing: every existing label is a conflict.
  for (const p of buildingPlans) {
    const content = await readFile(join(o.dir, `units-${p.key}.csv`), 'utf8').catch(() => '');
    if (!content.trim()) continue;
    const buildingId = buildingIdByKey.get(p.key);
    if (!buildingId) {
      // Dry run against a building that does not exist yet: count the file's data rows and move on.
      const rows = content.trim().split(/\r?\n/).length - 1;
      log(`DRY import ${rows} rows into ${p.name}`);
      summary.units.imported += rows;
      continue;
    }
    const result = await api.write<{ counts: { units: number; newContacts: number; openingBalances: number; conflicts: number } }>(
      'POST', `/api/buildings/${buildingId}/import/units`, { content, mode: 'skip' },
    );
    if (result) {
      summary.units.imported += result.counts.units;
      summary.units.skipped += result.counts.conflicts;
      summary.units.contacts += result.counts.newContacts;
      summary.units.openingBalances += result.counts.openingBalances;
    }
  }

  const bsPlans = await plan<BuildingServicePlan>('building-services.json');
  for (const [key, buildingId] of buildingIdByKey) {
    const mine = bsPlans.filter((p) => p.buildingKey === key);
    if (mine.length === 0) continue;
    const attached = new Set((await api.get<{ rows: { serviceId: string }[] }>(`/api/buildings/${buildingId}/services`)).rows.map((r) => r.serviceId));
    for (const p of mine) {
      const serviceId = serviceIds.get(p.serviceName);
      if (!serviceId) { log(`no service named ${p.serviceName}; skipping its building service`); continue; }
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

  for (const p of await plan<ReserveFundPlan>('reserve-fund.json')) {
    const buildingId = buildingIdByKey.get(p.buildingKey);
    if (!buildingId) continue;
    if (p.setting) {
      summary.reserveFund.settings++;
      await api.write('PUT', `/api/buildings/${buildingId}/reserve-fund`, p.setting);
    }
    if (p.openingBalanceMinor === 0) continue;
    // The opening balance is a posting, so it may only be booked into an empty fund.
    const state = dryRun ? { balanceMinor: 0 } : await api.get<{ balanceMinor: number }>(`/api/buildings/${buildingId}/reserve-fund`);
    if (state.balanceMinor !== 0) { log(`the reserve fund of ${p.buildingKey} is not empty; leaving its balance alone`); continue; }
    summary.reserveFund.openingBalances++;
    await api.write('POST', `/api/buildings/${buildingId}/reserve-fund/opening-balance`, { amountMinor: p.openingBalanceMinor, note: 'Domexa migration' });
  }

  return summary;
}
