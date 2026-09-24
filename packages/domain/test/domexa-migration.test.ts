import { describe, expect, it } from 'vitest';
import {
  buildingKeyOf, DEFAULT_SEPARATORS, domexaAmountToMinor, domexaBuildingServicesToDomar, domexaBuildingsToDomar,
  domexaReserveFundToDomar, domexaServicesToDomar, domexaTaxRatesToDomar, domexaUnitsToImportRows,
  mergeReports, reportToMarkdown, separatorsFromOrganization, statementToOpeningBalance,
} from '../src/migration/domexa.js';
import { rowsToCanonicalCsv } from '../src/import/serialize.js';
import { parseUnitImport } from '../src/import/units.js';

// Invented but plausible: the demo account was empty, so no real unit or contact row was observable.
const UNITS: unknown[] = [
  { id: 'u1', number: '1', floor: '1', type: 'apartment', areaM2: 54.5, ownerContactId: 'c1' },
  { id: 'u2', label: '2', floor: 1, type: 'стан', area: '62', attachedToUnitId: null,
    owner: { id: 'c2', firstName: 'Ана', lastName: 'Бошковска', email: 'ANA@example.mk', phone: '070222333' } },
  { id: 'u3', number: 'P-1', type: 'garage', ownerContactId: 'c1' },
  { id: 'u4', type: 'apartment', areaM2: 30 },
];
const CONTACTS = { c1: { id: 'c1', firstName: 'Марко', lastName: 'Марков', email: 'marko@example.mk', phone: '070111222' } };
const STATEMENTS = { c1: { closingBalance: '1234.56' }, c2: { balance: -450.5 } };

// Observed on /api/tax-rates of the demo account.
const TAX_RATES: unknown[] = [
  { id: '22a3a272-bc96-46dd-904a-c535340ff7dc', name: '/', rate: '0.00', isDefault: false, isActive: true },
  { id: 'd832b44b-6986-4b38-b2cb-df80c8277f97', name: 'ДДВ', rate: '18.00', isDefault: true, isActive: true },
];
const SERVICES: unknown[] = [
  { id: 's1', name: 'Чистење', categoryName: 'Чистење', pricingModel: 'fixed_per_unit', price: '300.00',
    taxRateId: 'd832b44b-6986-4b38-b2cb-df80c8277f97', appliesTo: ['apartment', 'commercial'], isRecurring: true },
  { id: 's2', name: 'Лифт', pricingModel: 'per_m2', price: 12.5, taxRateId: '22a3a272-bc96-46dd-904a-c535340ff7dc', appliesTo: [], isRecurring: true },
  { id: 's3', name: 'Заменета светилка', pricingModel: 'shared', price: '1200', isRecurring: false },
];

describe('domexaAmountToMinor', () => {
  it('reads the JSON number, the canonical string and the formatted string', () => {
    expect(domexaAmountToMinor(1234.56)).toBe(123456);
    expect(domexaAmountToMinor('1234.56')).toBe(123456);
    expect(domexaAmountToMinor('-450.5')).toBe(-45050);
    expect(domexaAmountToMinor('18.00')).toBe(1800); // percent × 100 is exactly rateBp
    expect(domexaAmountToMinor('1.234,56')).toBe(123456);
    expect(domexaAmountToMinor('1,234.56', { thousandSeparator: ',', decimalSeparator: '.' })).toBe(123456);
    expect(domexaAmountToMinor('')).toBeNull();
    expect(domexaAmountToMinor(null)).toBeNull();
    expect(domexaAmountToMinor('n/a')).toBeNull();
  });

  it('takes the separators from /api/organization and falls back to the mk defaults', () => {
    expect(separatorsFromOrganization({ thousandSeparator: '.', decimalSeparator: ',' })).toEqual(DEFAULT_SEPARATORS);
    expect(separatorsFromOrganization({})).toEqual(DEFAULT_SEPARATORS);
    expect(separatorsFromOrganization(null)).toEqual(DEFAULT_SEPARATORS);
  });
});

describe('statementToOpeningBalance', () => {
  it('is the closing balance, positive when the owner owes, and 0 when unreadable', () => {
    expect(statementToOpeningBalance({ closingBalance: '1234.56' })).toBe(123456);
    expect(statementToOpeningBalance({ balance: -450.5 })).toBe(-45050);
    expect(statementToOpeningBalance({ summary: { closingBalance: '10.00' } })).toBe(1000);
    expect(statementToOpeningBalance({})).toBe(0);
    expect(statementToOpeningBalance(undefined)).toBe(0);
  });
});

describe('domexaUnitsToImportRows', () => {
  const { rows, report } = domexaUnitsToImportRows(UNITS, CONTACTS, STATEMENTS);

  it('writes one canonical CSV row per unit that has a label', () => {
    expect(rowsToCanonicalCsv(rows)).toBe(
      'број;кат;тип;површина;удел;име;презиме;е-пошта;телефон;почетно салдо\n'
      + '1;1;apartment;54.5;;Марко;Марков;marko@example.mk;070111222;1234.56\n'
      + '2;1;apartment;62;;Ана;Бошковска;ANA@example.mk;070222333;-450.50\n'
      + 'P-1;;parking;;;Марко;Марков;marko@example.mk;070111222;0\n',
    );
  });

  it('produces a file our own parser accepts', () => {
    const parsed = parseUnitImport(rowsToCanonicalCsv(rows));
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows.map((r) => r.openingBalanceMinor)).toEqual([123456, -45050, 0]);
    expect(parsed.rows.map((r) => r.kind)).toEqual(['apartment', 'apartment', 'parking']);
    expect(parsed.rows[1]!.ownerEmail).toBe('ana@example.mk');
  });

  it('reports the unknown field, the skipped row, the guessed kind and the moved balance', () => {
    expect(report.counts).toEqual({ units: 4, rows: 3, owners: 2, openingBalances: 2 });
    expect(report.unknownFields).toEqual(['attachedToUnitId']);
    expect(report.skipped).toEqual([{ entity: 'unit', id: 'u4', reason: 'missing label' }]);
    expect(report.notes).toEqual([
      'unit P-1: kind "garage" → parking',
      "unit P-1: the owner's opening balance is on unit 1",
    ]);
  });

  it('never throws on a row that is not an object at all', () => {
    const odd = domexaUnitsToImportRows([null, 42, { number: '5', type: 'кутија' }], {}, {});
    expect(odd.rows).toHaveLength(1);
    expect(odd.rows[0]!.kind).toBe('other');
    expect(odd.report.skipped).toHaveLength(2);
    expect(odd.report.notes).toEqual(['unit 5: kind "кутија" is unknown → other']);
  });
});

describe('domexaTaxRatesToDomar', () => {
  it('turns a percent string into basis points', () => {
    const { rows, report } = domexaTaxRatesToDomar(TAX_RATES);
    expect(rows).toEqual([
      { name: '/', rateBp: 0, isDefault: false },
      { name: 'ДДВ', rateBp: 1800, isDefault: true },
    ]);
    expect(report.counts).toEqual({ taxRates: 2 });
  });
});

describe('domexaServicesToDomar', () => {
  const { rows, report } = domexaServicesToDomar(SERVICES, TAX_RATES);

  it('maps the pricing model, the price and the tax rate by name', () => {
    expect(rows).toEqual([
      { name: 'Чистење', category: 'Чистење', description: null, pricing: 'fixed_per_unit', defaultPriceMinor: 30000, taxRateName: 'ДДВ', appliesTo: ['apartment', 'commercial'], recurring: true },
      { name: 'Лифт', category: null, description: null, pricing: 'per_m2', defaultPriceMinor: 1250, taxRateName: '/', appliesTo: [], recurring: true },
      { name: 'Заменета светилка', category: null, description: null, pricing: 'shared_total', defaultPriceMinor: 120000, taxRateName: null, appliesTo: [], recurring: false },
    ]);
    expect(report.notes).toEqual(['service Заменета светилка: no tax rate — the tenant default applies']);
  });

  it('falls back to fixed_per_unit and says so', () => {
    const { rows: odd, report: r } = domexaServicesToDomar([{ id: 'x', name: 'Х', pricingModel: 'per_owner', price: '1' }], []);
    expect(odd[0]).toMatchObject({ pricing: 'fixed_per_unit', defaultPriceMinor: 100 });
    expect(r.notes).toContain('service Х: pricing "per_owner" is unknown → fixed_per_unit');
  });
});

describe('domexaBuildingsToDomar, building services and the reserve fund', () => {
  it('keeps a file-safe key per building', () => {
    const { rows } = domexaBuildingsToDomar([{ id: 'b/1', name: 'Партизанска 12', address: 'Партизанска 12', city: 'Скопје', postalCode: '1000' }]);
    expect(rows).toEqual([{ key: 'b-1', name: 'Партизанска 12', address: 'Партизанска 12', city: 'Скопје', postalCode: '1000' }]);
    expect(buildingKeyOf('b 1/2')).toBe('b-1-2');
  });

  it('turns a start date into a period and an interval into a frequency', () => {
    const { rows } = domexaBuildingServicesToDomar(
      [
        { id: 'bs1', serviceId: 's1', price: '350.00', frequency: 'monthly', intervalMonths: 1, startsAt: '2026-01-01', endsAt: null },
        { id: 'bs2', serviceId: 's2', intervalMonths: 3 },
      ],
      'b1', { s1: 'Чистење', s2: 'Лифт' }, '2026-09',
    );
    expect(rows).toEqual([
      { buildingKey: 'b1', serviceName: 'Чистење', priceMinor: 35000, pricing: null, frequency: 'monthly', intervalMonths: 1, startsPeriod: '2026-01', endsPeriod: null },
      { buildingKey: 'b1', serviceName: 'Лифт', priceMinor: null, pricing: null, frequency: 'every_n_months', intervalMonths: 3, startsPeriod: '2026-09', endsPeriod: null },
    ]);
  });

  it('reads the reserve fund setting and its balance', () => {
    const { plan } = domexaReserveFundToDomar('b1', { basis: 'per_m2', amount: '10.00', appliesTo: ['apartment'], isActive: true }, { balance: '35000.00' });
    expect(plan).toEqual({
      buildingKey: 'b1',
      setting: { basis: 'per_m2', amountMinor: 1000, appliesTo: ['apartment'], active: true },
      openingBalanceMinor: 3500000,
    });
  });

  it('survives a missing reserve fund entirely', () => {
    const { plan, report } = domexaReserveFundToDomar('b1', null, null);
    expect(plan).toEqual({ buildingKey: 'b1', setting: null, openingBalanceMinor: 0 });
    expect(report.notes).toContain('building b1: no reserve fund setting in the export');
  });
});

describe('the report', () => {
  it('merges and renders as markdown', () => {
    const merged = mergeReports([
      { counts: { units: 4 }, unknownFields: ['a'], skipped: [{ entity: 'unit', id: 'u4', reason: 'missing label' }], notes: ['n1'] },
      { counts: { units: 1, services: 3 }, unknownFields: ['a', 'b'], skipped: [], notes: [] },
    ]);
    expect(merged.counts).toEqual({ units: 5, services: 3 });
    expect(merged.unknownFields).toEqual(['a', 'b']);

    const md = reportToMarkdown(merged);
    expect(md.startsWith('# Domexa migration report\n\n## Counts\n\n- units: 5\n- services: 3\n')).toBe(true);
    expect(md).toContain('## Skipped rows\n\n- unit u4: missing label\n');
    expect(md).toContain('## Notes\n\n- n1\n');
    expect(reportToMarkdown({ counts: {}, unknownFields: [], skipped: [], notes: [] })).toContain('## Unknown fields\n\nNone.\n');
  });
});
