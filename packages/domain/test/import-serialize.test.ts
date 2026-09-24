import { describe, expect, it } from 'vitest';
import { CANONICAL_HEADER, emptyImportRow, rowsToCanonicalCsv } from '../src/import/serialize.js';
import { parseUnitImport } from '../src/import/units.js';

describe('rowsToCanonicalCsv', () => {
  it('writes the Macedonian canonical header even for no rows', () => {
    expect(CANONICAL_HEADER).toBe('број;кат;тип;површина;удел;име;презиме;е-пошта;телефон;почетно салдо');
    expect(rowsToCanonicalCsv([])).toBe(`${CANONICAL_HEADER}\n`);
  });

  it('writes one line per row in canonical column order', () => {
    const csv = rowsToCanonicalCsv([
      { ...emptyImportRow(), label: '1', floor: '1', kind: 'apartment', areaM2: '54,5', ownershipShare: '0,085', ownerFirstName: 'Марко', ownerLastName: 'Марков', ownerEmail: 'marko@example.mk', ownerPhone: '070111222', openingBalance: '1.200,00' },
      { ...emptyImportRow(), label: 'P-1', kind: 'parking' },
    ]);
    expect(csv).toBe(
      `${CANONICAL_HEADER}\n`
      + '1;1;apartment;54,5;0,085;Марко;Марков;marko@example.mk;070111222;1.200,00\n'
      + 'P-1;;parking;;;;;;;\n',
    );
  });

  it('quotes a cell with a semicolon or a quote, doubles the quote and flattens a line break', () => {
    const csv = rowsToCanonicalCsv([
      { ...emptyImportRow(), label: 'A;1', floor: '1\n2', kind: 'apartment', ownerLastName: 'Марков "Мар"', openingBalance: '0' },
    ]);
    expect(csv).toBe(`${CANONICAL_HEADER}\n"A;1";1 2;apartment;;;;"Марков ""Мар""";;;0\n`);
  });

  it('round-trips through the parser it feeds', () => {
    const csv = rowsToCanonicalCsv([
      { ...emptyImportRow(), label: 'A;1', kind: 'apartment', areaM2: '54.5', ownerLastName: 'Марков "Мар"', openingBalance: '-450.50' },
    ]);
    const { rows, errors } = parseUnitImport(csv);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: 'A;1', kind: 'apartment', areaM2: 54.5, ownerLastName: 'Марков "Мар"', openingBalanceMinor: -45050 });
  });
});
