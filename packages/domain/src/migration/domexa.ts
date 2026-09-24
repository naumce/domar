import type { UnitKind } from '../calculation/types.js';
import { mkPack } from '../country/mk.js';
import { emptyImportRow } from '../import/serialize.js';
import { type ImportField, normaliseKind } from '../import/units.js';

/**
 * Domexa's unit, contact and building row shapes were never observable — the demo account was empty
 * — so every accessor here takes a list of candidate paths, tolerates a missing field, records what
 * it did not understand and never throws on a row (spec §20.3).
 */

// ---------------------------------------------------------------- the report

export interface MigrationReport {
  counts: Record<string, number>;
  unknownFields: string[];
  skipped: { entity: string; id: string; reason: string }[];
  notes: string[];
}

export function emptyReport(): MigrationReport {
  return { counts: {}, unknownFields: [], skipped: [], notes: [] };
}

export function mergeReports(reports: MigrationReport[]): MigrationReport {
  const out = emptyReport();
  for (const r of reports) {
    for (const [k, v] of Object.entries(r.counts)) out.counts[k] = (out.counts[k] ?? 0) + v;
    for (const f of r.unknownFields) if (!out.unknownFields.includes(f)) out.unknownFields.push(f);
    out.skipped.push(...r.skipped);
    out.notes.push(...r.notes);
  }
  return out;
}

export function reportToMarkdown(report: MigrationReport): string {
  const section = (title: string, lines: string[]): string =>
    `## ${title}\n\n${lines.length > 0 ? lines.map((l) => `- ${l}`).join('\n') : 'None.'}\n`;
  return [
    '# Domexa migration report',
    '',
    section('Counts', Object.entries(report.counts).map(([k, v]) => `${k}: ${v}`)),
    section('Unknown fields', report.unknownFields),
    section('Skipped rows', report.skipped.map((s) => `${s.entity} ${s.id}: ${s.reason}`)),
    section('Notes', report.notes),
  ].join('\n');
}

// ------------------------------------------------------------ tolerant reads

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function readPath(row: unknown, path: string): unknown {
  let cur: unknown = row;
  for (const part of path.split('.')) {
    if (!isRecord(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** The first candidate path that carries something other than undefined, null or an empty string. */
function firstOf(row: unknown, paths: readonly string[]): unknown {
  for (const p of paths) {
    const v = readPath(row, p);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/** What a CSV cell can carry. An object or an array never becomes a cell. */
function text(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

// ----------------------------------------------------------------- the numbers

export interface DomexaSeparators { thousandSeparator: string; decimalSeparator: string }
export const DEFAULT_SEPARATORS: DomexaSeparators = { thousandSeparator: '.', decimalSeparator: ',' };

export function separatorsFromOrganization(org: unknown): DomexaSeparators {
  return {
    thousandSeparator: text(readPath(org, 'thousandSeparator')) || DEFAULT_SEPARATORS.thousandSeparator,
    decimalSeparator: text(readPath(org, 'decimalSeparator')) || DEFAULT_SEPARATORS.decimalSeparator,
  };
}

const sepEqualsDefault = (sep: DomexaSeparators): boolean =>
  sep.thousandSeparator === DEFAULT_SEPARATORS.thousandSeparator && sep.decimalSeparator === DEFAULT_SEPARATORS.decimalSeparator;

/**
 * Domexa sends amounts as JSON numbers and as strings. `"18.00"` and `"1234.56"` (observed on
 * /api/tax-rates) are already canonical *only* when the organization uses the mk default
 * separators — those fields bypass the org's display settings entirely. Any other value, or any
 * value under a non-default separator pair, is normalised first: the thousand separator is
 * stripped and the decimal separator is rewritten as `,` (never `.`) before the mk parser reads
 * it, because the parser only treats a lone `,` as unambiguously decimal — a lone `.` with a
 * 3-digit tail is still read as a thousands group. Unreadable → null, never an exception.
 */
export function domexaAmountToMinor(value: unknown, sep: DomexaSeparators = DEFAULT_SEPARATORS): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) : null;
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (raw === '') return null;
  const canonical = sepEqualsDefault(sep) && /^-?\d+(\.\d+)?$/.test(raw)
    ? raw
    : raw.split(sep.thousandSeparator).join('').split(sep.decimalSeparator).join(',');
  try {
    return mkPack.parseAmountToMinor(canonical);
  } catch {
    return null;
  }
}

// -------------------------------------------------------------- the field map

export type DomarPricing = 'fixed_per_unit' | 'per_m2' | 'shared_total';

export interface DomexaFieldMap {
  unit: Record<ImportField, readonly string[]>;
  unitOwnerId: readonly string[];
  contact: Record<'firstName' | 'lastName' | 'email' | 'phone', readonly string[]>;
  statement: Record<'closingBalance', readonly string[]>;
  building: Record<'name' | 'address' | 'city' | 'postalCode', readonly string[]>;
  service: Record<'name' | 'category' | 'description' | 'pricing' | 'price' | 'taxRateId' | 'appliesTo' | 'recurring', readonly string[]>;
  buildingService: Record<'serviceId' | 'price' | 'pricing' | 'frequency' | 'intervalMonths' | 'startsAt' | 'endsAt', readonly string[]>;
  reserveFund: Record<'basis' | 'amount' | 'appliesTo' | 'active' | 'balance', readonly string[]>;
}

/** The starting guess. `transform --map <file>` overrides any subtree of it (docs/MIGRATION.md). */
export const DEFAULT_FIELD_MAP: DomexaFieldMap = {
  unit: {
    label: ['number', 'unitNumber', 'label', 'name', 'code'],
    floor: ['floor', 'floorNumber', 'level'],
    kind: ['type', 'unitType', 'kind'],
    areaM2: ['areaM2', 'area', 'surface', 'squareMeters', 'm2'],
    ownershipShare: ['ownershipShare', 'share', 'coOwnershipShare'],
    ownerFirstName: ['owner.firstName', 'ownerFirstName', 'contact.firstName'],
    ownerLastName: ['owner.lastName', 'ownerLastName', 'contact.lastName'],
    ownerEmail: ['owner.email', 'ownerEmail', 'contact.email'],
    ownerPhone: ['owner.phone', 'ownerPhone', 'contact.phone'],
    openingBalance: [], // never on the unit: it comes from the contact's statement (§20.2)
  },
  unitOwnerId: ['ownerContactId', 'ownerId', 'contactId', 'owner.id', 'contact.id'],
  contact: {
    firstName: ['firstName', 'first_name', 'givenName'],
    lastName: ['lastName', 'last_name', 'familyName', 'surname'],
    email: ['email', 'emailAddress'],
    phone: ['phone', 'phoneNumber', 'mobile'],
  },
  statement: { closingBalance: ['closingBalance', 'balance', 'outstandingBalance', 'totalOutstanding', 'closing.balance', 'summary.closingBalance'] },
  building: {
    name: ['name', 'title', 'label'],
    address: ['address', 'street', 'addressLine1'],
    city: ['city', 'town'],
    postalCode: ['postalCode', 'zip', 'postCode'],
  },
  service: {
    name: ['name', 'title'],
    category: ['categoryName', 'category.name', 'category'],
    description: ['description', 'note'],
    pricing: ['pricingModel', 'pricing', 'priceModel', 'model'],
    price: ['price', 'defaultPrice', 'amount', 'unitPrice'],
    taxRateId: ['taxRateId', 'taxRate.id', 'vatRateId'],
    appliesTo: ['appliesTo', 'unitTypes', 'appliesToUnitTypes'],
    recurring: ['isRecurring', 'recurring'],
  },
  buildingService: {
    serviceId: ['serviceId', 'service.id'],
    price: ['price', 'priceOverride', 'amount'],
    pricing: ['pricingModel', 'pricing', 'priceModel'],
    frequency: ['frequency'],
    intervalMonths: ['intervalMonths', 'everyNMonths', 'interval'],
    startsAt: ['startsAt', 'startDate', 'validFrom', 'startPeriod'],
    endsAt: ['endsAt', 'endDate', 'validTo', 'endPeriod'],
  },
  reserveFund: {
    basis: ['basis', 'calculationBasis', 'mode'],
    amount: ['amount', 'amountPerUnit', 'monthlyAmount', 'rate'],
    appliesTo: ['appliesTo', 'unitTypes'],
    active: ['isActive', 'active', 'enabled'],
    balance: ['balance', 'currentBalance', 'openingBalance', 'total'],
  },
};

/** The five kinds the Domexa guide names, in the English words an API is likely to use. */
const DOMEXA_UNIT_KINDS: Record<string, UnitKind> = {
  flat: 'apartment', residential: 'apartment', home: 'apartment',
  office: 'commercial', business: 'commercial', shop: 'commercial', retail: 'commercial', local: 'commercial',
  garage: 'parking', parkingspot: 'parking', parkingspace: 'parking',
  basement: 'storage', cellar: 'storage', depot: 'storage',
};

const PRICING: Record<string, DomarPricing> = {
  fixedperunit: 'fixed_per_unit', fixed: 'fixed_per_unit', perunit: 'fixed_per_unit', 'поединица': 'fixed_per_unit',
  perm2: 'per_m2', area: 'per_m2', byarea: 'per_m2', 'поm2': 'per_m2', 'пом2': 'per_m2',
  sharedtotal: 'shared_total', shared: 'shared_total', total: 'shared_total', split: 'shared_total', 'заедничко': 'shared_total',
};

const squash = (s: string): string => s.trim().toLowerCase().replace(/[\s_-]+/g, '');

function unitKindOf(raw: string, label: string, report: MigrationReport): UnitKind {
  const direct = normaliseKind(raw);
  if (direct) return direct;
  const guess = DOMEXA_UNIT_KINDS[squash(raw)];
  if (guess) { report.notes.push(`unit ${label}: kind "${raw}" → ${guess}`); return guess; }
  report.notes.push(`unit ${label}: kind "${raw || '(empty)'}" is unknown → other`);
  return 'other';
}

function kindList(value: unknown, owner: string, report: MigrationReport): UnitKind[] {
  if (!Array.isArray(value)) return [];
  const out: UnitKind[] = [];
  for (const v of value) {
    const raw = text(v);
    const kind = normaliseKind(raw) ?? DOMEXA_UNIT_KINDS[squash(raw)];
    if (kind) { if (!out.includes(kind)) out.push(kind); }
    else report.notes.push(`${owner}: unit kind "${raw}" is unknown and was dropped`);
  }
  return out;
}

// -------------------------------------------------------------------- units

const IGNORED_UNIT_KEYS = ['id', 'buildingId', 'propertyId', 'organizationId', 'tenantId', 'createdAt', 'updatedAt'];

function consumedRoots(map: DomexaFieldMap): Set<string> {
  const roots = new Set<string>(IGNORED_UNIT_KEYS);
  for (const paths of Object.values(map.unit)) for (const p of paths) roots.add(p.split('.')[0]!);
  for (const p of map.unitOwnerId) roots.add(p.split('.')[0]!);
  return roots;
}

/**
 * Domexa units (+ the contacts and statements they point at) → canonical import rows. An owner's
 * closing balance lands on their *first* unit only: the import books one posting per row with a
 * balance, so repeating it would multiply the debt (design addendum 14).
 */
export function domexaUnitsToImportRows(
  units: unknown[],
  contactsById: Record<string, unknown>,
  statementsByContactId: Record<string, unknown>,
  map: DomexaFieldMap = DEFAULT_FIELD_MAP,
  sep: DomexaSeparators = DEFAULT_SEPARATORS,
): { rows: Record<ImportField, string>[]; report: MigrationReport } {
  const report = emptyReport();
  const rows: Record<ImportField, string>[] = [];
  const known = consumedRoots(map);
  const balanceOn = new Map<string, string>();
  const owners = new Set<string>();
  const labelFirstSeenId = new Map<string, string>();
  let openingBalances = 0;

  for (const unit of units) {
    if (isRecord(unit)) {
      for (const key of Object.keys(unit)) {
        if (!known.has(key) && !report.unknownFields.includes(key)) report.unknownFields.push(key);
      }
    }
    const id = text(firstOf(unit, ['id', 'number', 'label'])) || '(no id)';
    const label = text(firstOf(unit, map.unit.label));
    if (!label) { report.skipped.push({ entity: 'unit', id, reason: 'missing label' }); continue; }

    const row = emptyImportRow();
    row.label = label;
    row.floor = text(firstOf(unit, map.unit.floor));
    row.areaM2 = text(firstOf(unit, map.unit.areaM2));
    row.ownershipShare = text(firstOf(unit, map.unit.ownershipShare));
    row.kind = unitKindOf(text(firstOf(unit, map.unit.kind)), label, report);

    const ownerId = text(firstOf(unit, map.unitOwnerId));
    const contact = ownerId ? contactsById[ownerId] : undefined;
    row.ownerFirstName = text(firstOf(unit, map.unit.ownerFirstName)) || text(firstOf(contact, map.contact.firstName));
    row.ownerLastName = text(firstOf(unit, map.unit.ownerLastName)) || text(firstOf(contact, map.contact.lastName));
    row.ownerEmail = text(firstOf(unit, map.unit.ownerEmail)) || text(firstOf(contact, map.contact.email));
    row.ownerPhone = text(firstOf(unit, map.unit.ownerPhone)) || text(firstOf(contact, map.contact.phone));
    if (ownerId && contact === undefined && !row.ownerLastName) {
      report.notes.push(`contact ${ownerId} is not in the export; owner name left empty`);
    }

    const firstLabelId = labelFirstSeenId.get(label);
    if (firstLabelId) report.notes.push(`unit ${id}: label "${label}" is already used by unit ${firstLabelId} in this building — the parser will reject the duplicate`);
    else labelFirstSeenId.set(label, id);

    const key = ownerId || (row.ownerLastName ? `${row.ownerFirstName}|${row.ownerLastName}` : '');
    row.openingBalance = '0';
    if (key) {
      owners.add(key);
      const carrier = balanceOn.get(key);
      if (carrier) report.notes.push(`unit ${label}: the owner's opening balance is on unit ${carrier}`);
      else {
        balanceOn.set(key, label);
        const minor = key === ownerId ? statementToOpeningBalance(statementsByContactId[key], map, sep) : 0;
        row.openingBalance = (minor / 100).toFixed(2);
        if (minor !== 0) openingBalances++;
      }
    }
    rows.push(row);
  }

  report.counts = { units: units.length, rows: rows.length, owners: owners.size, openingBalances };
  return { rows, report };
}

/** The contact statement's closing balance as signed minor units; positive = the owner owes. */
export function statementToOpeningBalance(
  statement: unknown,
  map: DomexaFieldMap = DEFAULT_FIELD_MAP,
  sep: DomexaSeparators = DEFAULT_SEPARATORS,
): number {
  return domexaAmountToMinor(firstOf(statement, map.statement.closingBalance), sep) ?? 0;
}

// ---------------------------------------------------- tax rates and services

export interface DomarTaxRatePlan { name: string; rateBp: number; isDefault: boolean }

/** A Domexa percent (`"18.00"`) is basis points once multiplied by 100 — which is what minor is. */
export function domexaTaxRatesToDomar(rows: unknown[], sep: DomexaSeparators = DEFAULT_SEPARATORS): { rows: DomarTaxRatePlan[]; report: MigrationReport } {
  const report = emptyReport();
  const out: DomarTaxRatePlan[] = [];
  for (const r of rows) {
    const id = text(firstOf(r, ['id'])) || '(no id)';
    const name = text(firstOf(r, ['name', 'label']));
    const rateBp = domexaAmountToMinor(firstOf(r, ['rate', 'percent', 'value']), sep);
    if (!name || rateBp === null) {
      report.skipped.push({ entity: 'taxRate', id, reason: name ? 'unreadable rate' : 'missing name' });
      continue;
    }
    out.push({ name, rateBp, isDefault: readPath(r, 'isDefault') === true });
  }
  report.counts = { taxRates: out.length };
  return { rows: out, report };
}

export interface DomarServicePlan {
  name: string; category: string | null; description: string | null;
  pricing: DomarPricing; defaultPriceMinor: number; taxRateName: string | null;
  appliesTo: UnitKind[]; recurring: boolean;
}

export function domexaServicesToDomar(
  services: unknown[],
  taxRates: unknown[],
  map: DomexaFieldMap = DEFAULT_FIELD_MAP,
  sep: DomexaSeparators = DEFAULT_SEPARATORS,
): { rows: DomarServicePlan[]; report: MigrationReport } {
  const report = emptyReport();
  const names = new Map<string, string>();
  for (const r of taxRates) {
    const id = text(firstOf(r, ['id']));
    const name = text(firstOf(r, ['name', 'label']));
    if (id && name) names.set(id, name);
  }

  const out: DomarServicePlan[] = [];
  for (const s of services) {
    const id = text(firstOf(s, ['id'])) || '(no id)';
    const name = text(firstOf(s, map.service.name));
    if (!name) { report.skipped.push({ entity: 'service', id, reason: 'missing name' }); continue; }

    const rawPricing = text(firstOf(s, map.service.pricing));
    let pricing = PRICING[squash(rawPricing)];
    if (!pricing) {
      report.notes.push(`service ${name}: pricing "${rawPricing || '(empty)'}" is unknown → fixed_per_unit`);
      pricing = 'fixed_per_unit';
    }
    const taxRateId = text(firstOf(s, map.service.taxRateId));
    const taxRateName = taxRateId ? names.get(taxRateId) ?? null : null;
    if (!taxRateId) report.notes.push(`service ${name}: no tax rate — the tenant default applies`);
    else if (!taxRateName) report.notes.push(`service ${name}: tax rate ${taxRateId} is not in the export`);
    const recurring = firstOf(s, map.service.recurring);

    out.push({
      name,
      category: text(firstOf(s, map.service.category)) || null,
      description: text(firstOf(s, map.service.description)) || null,
      pricing,
      defaultPriceMinor: domexaAmountToMinor(firstOf(s, map.service.price), sep) ?? 0,
      taxRateName,
      appliesTo: kindList(firstOf(s, map.service.appliesTo), `service ${name}`, report),
      recurring: recurring === undefined ? true : recurring === true,
    });
  }
  report.counts = { services: out.length };
  return { rows: out, report };
}

/**
 * The id → name index `domexaBuildingServicesToDomar` resolves a `serviceId` through. It reads the
 * name through the same map as the service catalogue, so a `--map` override of `service.name`
 * applies to both and a building service is not skipped as "not in the export".
 */
export function domexaServiceNamesById(services: unknown[], map: DomexaFieldMap = DEFAULT_FIELD_MAP): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of services) {
    const id = text(firstOf(s, ['id']));
    const name = text(firstOf(s, map.service.name));
    if (id && name) out[id] = name;
  }
  return out;
}

// ------------------------------------- buildings, building services, the fund

export interface DomarBuildingPlan { key: string; name: string; address: string; city: string; postalCode: string }

/**
 * A Domexa id as a file-name-safe key; it ties `units-<key>.csv` to the JSON plans. Letters and
 * digits of any script survive — Cyrillic ids must not all collapse onto the same key.
 */
export function buildingKeyOf(id: string): string {
  return id.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '-');
}

export function domexaBuildingsToDomar(buildings: unknown[], map: DomexaFieldMap = DEFAULT_FIELD_MAP): { rows: DomarBuildingPlan[]; report: MigrationReport } {
  const report = emptyReport();
  const out: DomarBuildingPlan[] = [];
  for (const b of buildings) {
    const id = text(firstOf(b, ['id'])) || '(no id)';
    const name = text(firstOf(b, map.building.name));
    if (!name) { report.skipped.push({ entity: 'building', id, reason: 'missing name' }); continue; }
    out.push({
      key: buildingKeyOf(id),
      name,
      address: text(firstOf(b, map.building.address)),
      city: text(firstOf(b, map.building.city)),
      postalCode: text(firstOf(b, map.building.postalCode)),
    });
  }
  report.counts = { buildings: out.length };
  return { rows: out, report };
}

export interface DomarBuildingServicePlan {
  buildingKey: string; serviceName: string; priceMinor: number | null; pricing: DomarPricing | null;
  frequency: 'monthly' | 'every_n_months'; intervalMonths: number; startsPeriod: string; endsPeriod: string | null;
}

/** The frequency words that mean exactly what domar's `monthly` means, so they need no note. */
const MONTHLY_FREQUENCIES = ['monthly', 'month', 'месечно'];

/** `2026-01-01`, `2026-01-01T00:00:00Z` and `2026-01` all read as the period `2026-01`. */
function periodOf(value: unknown): string | null {
  const m = /^(\d{4})-(\d{2})/.exec(text(value));
  return m ? `${m[1]}-${m[2]}` : null;
}

export function domexaBuildingServicesToDomar(
  rows: unknown[],
  buildingKey: string,
  serviceNamesById: Record<string, string>,
  fallbackStartsPeriod: string,
  map: DomexaFieldMap = DEFAULT_FIELD_MAP,
  sep: DomexaSeparators = DEFAULT_SEPARATORS,
): { rows: DomarBuildingServicePlan[]; report: MigrationReport } {
  const report = emptyReport();
  const out: DomarBuildingServicePlan[] = [];
  for (const r of rows) {
    const id = text(firstOf(r, ['id'])) || '(no id)';
    const serviceId = text(firstOf(r, map.buildingService.serviceId));
    const serviceName = serviceNamesById[serviceId];
    if (!serviceName) { report.skipped.push({ entity: 'buildingService', id, reason: `service ${serviceId || '(none)'} is not in the export` }); continue; }

    const rawPricing = text(firstOf(r, map.buildingService.pricing));
    const pricing = rawPricing ? PRICING[squash(rawPricing)] ?? null : null;
    if (rawPricing && !pricing) report.notes.push(`building service ${serviceName}: pricing "${rawPricing}" is unknown → the catalogue model applies`);
    const interval = firstOf(r, map.buildingService.intervalMonths);
    const intervalRaw = Number(text(interval));
    const intervalMonths = Number.isFinite(intervalRaw) && intervalRaw >= 1 && intervalRaw <= 24 ? Math.trunc(intervalRaw) : 1;
    // domar bills monthly or every N months; a Domexa frequency word we cannot turn into an N is a
    // guess the operator has to check, not a silent monthly.
    const rawFrequency = text(firstOf(r, map.buildingService.frequency));
    if (rawFrequency && !MONTHLY_FREQUENCIES.includes(squash(rawFrequency)) && interval === undefined) {
      report.notes.push(`building service ${serviceName}: frequency "${rawFrequency}" carries no interval in months → monthly`);
    }
    const startsPeriod = periodOf(firstOf(r, map.buildingService.startsAt)) ?? fallbackStartsPeriod;

    out.push({
      buildingKey, serviceName,
      priceMinor: domexaAmountToMinor(firstOf(r, map.buildingService.price), sep),
      pricing,
      frequency: intervalMonths > 1 ? 'every_n_months' : 'monthly',
      intervalMonths,
      startsPeriod,
      endsPeriod: periodOf(firstOf(r, map.buildingService.endsAt)),
    });
  }
  report.counts = { buildingServices: out.length };
  return { rows: out, report };
}

export interface DomarReserveFundPlan {
  buildingKey: string;
  setting: { basis: 'per_unit' | 'per_m2'; amountMinor: number; appliesTo: UnitKind[]; active: boolean } | null;
  openingBalanceMinor: number;
}

export function domexaReserveFundToDomar(
  buildingKey: string,
  setting: unknown,
  balance: unknown,
  map: DomexaFieldMap = DEFAULT_FIELD_MAP,
  sep: DomexaSeparators = DEFAULT_SEPARATORS,
): { plan: DomarReserveFundPlan; report: MigrationReport } {
  const report = emptyReport();
  const amountMinor = domexaAmountToMinor(firstOf(setting, map.reserveFund.amount), sep);
  let resolved: DomarReserveFundPlan['setting'] = null;
  if (amountMinor === null) report.notes.push(`building ${buildingKey}: no reserve fund setting in the export`);
  else {
    const rawBasis = squash(text(firstOf(setting, map.reserveFund.basis)));
    const basis = ['perm2', 'area', 'byarea', 'пом2', 'поm2'].includes(rawBasis) ? 'per_m2' : 'per_unit';
    if (rawBasis && basis === 'per_unit' && !['perunit', 'unit', 'fixed', 'поединица'].includes(rawBasis)) {
      report.notes.push(`building ${buildingKey}: reserve fund basis "${rawBasis}" is unknown → per_unit`);
    }
    resolved = {
      basis,
      amountMinor,
      appliesTo: kindList(firstOf(setting, map.reserveFund.appliesTo), `building ${buildingKey} reserve fund`, report),
      active: firstOf(setting, map.reserveFund.active) !== false,
    };
  }
  const openingBalanceMinor = domexaAmountToMinor(firstOf(balance, map.reserveFund.balance), sep) ?? 0;
  report.counts = { reserveFunds: resolved ? 1 : 0 };
  return { plan: { buildingKey, setting: resolved, openingBalanceMinor }, report };
}
