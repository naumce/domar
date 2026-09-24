import type { UnitKind } from '../calculation/types.js';
import { mkPack } from '../country/mk.js';
import { splitCsvLine } from '../statements/csv.js';

export interface UnitImportRow {
  line: number;
  label: string;
  floor: string | null;
  kind: UnitKind;
  areaM2: number | null;
  ownershipShare: number | null;
  ownerFirstName: string | null;
  ownerLastName: string | null;
  ownerEmail: string | null;
  ownerPhone: string | null;
  openingBalanceMinor: number;
}
export interface UnitImportError { line: number; message: string }
export interface UnitImportResult { rows: UnitImportRow[]; errors: UnitImportError[] }

type Field =
  | 'label' | 'floor' | 'kind' | 'areaM2' | 'ownershipShare'
  | 'ownerFirstName' | 'ownerLastName' | 'ownerEmail' | 'ownerPhone' | 'openingBalance';

const HEADERS: Record<string, Field> = {
  label: 'label', 'број': 'label',
  floor: 'floor', 'кат': 'floor',
  kind: 'kind', 'тип': 'kind',
  aream2: 'areaM2', 'површина': 'areaM2',
  ownershipshare: 'ownershipShare', 'удел': 'ownershipShare',
  ownerfirstname: 'ownerFirstName', 'име': 'ownerFirstName',
  ownerlastname: 'ownerLastName', 'презиме': 'ownerLastName',
  owneremail: 'ownerEmail', 'е-пошта': 'ownerEmail', 'епошта': 'ownerEmail',
  ownerphone: 'ownerPhone', 'телефон': 'ownerPhone',
  openingbalance: 'openingBalance', 'почетно салдо': 'openingBalance',
};

const KINDS: Record<string, UnitKind> = {
  apartment: 'apartment', 'стан': 'apartment',
  commercial: 'commercial', 'деловен': 'commercial', 'деловен простор': 'commercial',
  parking: 'parking', 'паркинг': 'parking',
  storage: 'storage', 'подрум': 'storage', 'остава': 'storage',
  other: 'other', 'друго': 'other',
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** "54,5" or "54.5" → 54.5; anything else → null. */
function parseDecimal(raw: string): number | null {
  const s = raw.replace(/\s/g, '');
  if (!/^-?\d+([.,]\d+)?$/.test(s)) return null;
  return Number(s.replace(',', '.'));
}

/** Parses the fixed units/owners template. Never throws: bad rows become errors and are skipped. */
export function parseUnitImport(text: string): UnitImportResult {
  const rows: UnitImportRow[] = [];
  const errors: UnitImportError[] = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => l.trim() !== '');
  if (headerIdx === -1) return { rows, errors: [{ line: 1, message: 'empty file' }] };

  const headerLine = lines[headerIdx]!;
  const delim = headerLine.split(';').length >= headerLine.split(',').length ? ';' : ',';
  const cols = splitCsvLine(headerLine, delim).map((c) => HEADERS[norm(c)] ?? null);
  const at = (f: Field): number => cols.indexOf(f);
  for (const required of ['label', 'kind'] as const) {
    if (at(required) === -1) errors.push({ line: headerIdx + 1, message: `missing required column: ${required}` });
  }
  if (errors.length > 0) return { rows, errors };

  const seen = new Set<string>();
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim() === '') continue;
    const line = i + 1;
    const cells = splitCsvLine(raw, delim);
    const cell = (f: Field): string => { const j = at(f); return j === -1 ? '' : (cells[j] ?? '').trim(); };

    const label = cell('label');
    if (!label) { errors.push({ line, message: 'label is required' }); continue; }
    if (seen.has(label)) { errors.push({ line, message: `duplicate label in file: ${label}` }); continue; }

    const kindRaw = cell('kind');
    const kind = KINDS[norm(kindRaw)];
    if (!kind) { errors.push({ line, message: `unknown kind: ${kindRaw || '(empty)'}` }); continue; }

    let areaM2: number | null = null;
    const areaRaw = cell('areaM2');
    if (areaRaw) {
      const v = parseDecimal(areaRaw);
      if (v === null || v <= 0 || v > 99_999_999) { errors.push({ line, message: `invalid areaM2: ${areaRaw}` }); continue; }
      areaM2 = v;
    }

    let ownershipShare: number | null = null;
    const shareRaw = cell('ownershipShare');
    if (shareRaw) {
      const v = parseDecimal(shareRaw);
      if (v === null || v < 0 || v > 1) { errors.push({ line, message: `invalid ownershipShare: ${shareRaw}` }); continue; }
      ownershipShare = v;
    }

    const email = cell('ownerEmail');
    if (email && !EMAIL.test(email)) { errors.push({ line, message: `invalid ownerEmail: ${email}` }); continue; }
    const ownerFirstName = cell('ownerFirstName');
    const ownerLastName = cell('ownerLastName');
    const ownerPhone = cell('ownerPhone');
    if (!ownerLastName && (ownerFirstName || email || ownerPhone)) {
      errors.push({ line, message: 'ownerLastName is required when any other owner column is filled' });
      continue;
    }

    let openingBalanceMinor = 0;
    const balanceRaw = cell('openingBalance');
    if (balanceRaw) {
      try {
        openingBalanceMinor = mkPack.parseAmountToMinor(balanceRaw);
      } catch {
        errors.push({ line, message: `invalid openingBalance: ${balanceRaw}` });
        continue;
      }
    }

    seen.add(label);
    rows.push({
      line, label, floor: cell('floor') || null, kind, areaM2, ownershipShare,
      ownerFirstName: ownerFirstName || null, ownerLastName: ownerLastName || null,
      ownerEmail: email ? email.toLowerCase() : null, ownerPhone: ownerPhone || null, openingBalanceMinor,
    });
  }
  return { rows, errors };
}
