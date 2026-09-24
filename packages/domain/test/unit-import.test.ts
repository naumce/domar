import { describe, expect, it } from 'vitest';
import { parseUnitImport } from '../src/import/units.js';

const MK_FILE =
  '﻿број;кат;тип;површина;удел;име;презиме;е-пошта;телефон;почетно салдо\r\n' +
  '1;1;стан;54,5;0,085;Марко;Марков;marko@example.mk;070111222;1.200,00\r\n' +
  '2;1;стан;62;0,095;Ана;Бошковска;ANA@example.mk;;-450,50\r\n' +
  '"L-1";0;деловен;88,25;;Зоран;Зорановски;;071333444;0\r\n' +
  'P-1;;паркинг;;;;;;;\r\n' +
  '1;2;стан;40;;;;;;\r\n' +
  '6;;кутија;30;;;;;;\r\n';

describe('parseUnitImport', () => {
  it('parses a Macedonian semicolon file with a BOM, CRLF, quotes and decimal commas', () => {
    const { rows, errors } = parseUnitImport(MK_FILE);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({
      line: 2, label: '1', floor: '1', kind: 'apartment', areaM2: 54.5, ownershipShare: 0.085,
      ownerFirstName: 'Марко', ownerLastName: 'Марков', ownerEmail: 'marko@example.mk', ownerPhone: '070111222',
      openingBalanceMinor: 120000,
    });
    expect(rows[1]).toMatchObject({ line: 3, label: '2', ownerEmail: 'ana@example.mk', ownerPhone: null, openingBalanceMinor: -45050 });
    expect(rows[2]).toMatchObject({ line: 4, label: 'L-1', kind: 'commercial', areaM2: 88.25, ownershipShare: null, ownerEmail: null, openingBalanceMinor: 0 });
    expect(rows[3]).toEqual({
      line: 5, label: 'P-1', floor: null, kind: 'parking', areaM2: null, ownershipShare: null,
      ownerFirstName: null, ownerLastName: null, ownerEmail: null, ownerPhone: null, openingBalanceMinor: 0,
    });
    expect(errors).toHaveLength(2);
    expect(errors[0]!.line).toBe(6);
    expect(errors[0]!.message).toContain('duplicate label');
    expect(errors[1]).toEqual({ line: 7, message: 'unknown kind: кутија' });
  });

  it('parses an English comma file with decimal points', () => {
    const text = 'label,floor,kind,areaM2,ownershipShare,ownerFirstName,ownerLastName,ownerEmail,ownerPhone,openingBalance\n'
      + '10,2,apartment,48.75,0.07,Ivan,Ivanov,ivan@example.mk,070999888,1200.00\n';
    const { rows, errors } = parseUnitImport(text);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: '10', kind: 'apartment', areaM2: 48.75, ownershipShare: 0.07, openingBalanceMinor: 120000 });
  });

  it('keeps a quoted delimiter inside a field', () => {
    const { rows, errors } = parseUnitImport('label;kind;floor\nA1;стан;"3, поткровје"\n');
    expect(errors).toEqual([]);
    expect(rows[0]!.floor).toBe('3, поткровје');
  });

  it('reports a missing required column and parses nothing', () => {
    const { rows, errors } = parseUnitImport('број;кат;површина\n1;1;50\n');
    expect(rows).toEqual([]);
    expect(errors).toEqual([{ line: 1, message: 'missing required column: kind' }]);
  });

  it('rejects owner details without a surname and invalid numbers', () => {
    const text = 'label;kind;ownerFirstName;ownerLastName;areaM2;openingBalance\n'
      + 'A;стан;Марко;;50;0\n'
      + 'B;стан;;Марков;abc;0\n'
      + 'C;стан;;Марков;50;xyz\n'
      + 'D;стан;;Марков;50;0\n';
    const { rows, errors } = parseUnitImport(text);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe('D');
    expect(errors.map((e) => e.line)).toEqual([2, 3, 4]);
    expect(errors[0]!.message).toContain('ownerLastName');
    expect(errors[1]!.message).toBe('invalid areaM2: abc');
    expect(errors[2]!.message).toBe('invalid openingBalance: xyz');
  });

  it('rejects an opening balance on a row with no owner', () => {
    const { rows, errors } = parseUnitImport('label;kind;openingBalance\nA;стан;1.200,00\nB;стан;0\n');
    expect(rows.map((r) => r.label)).toEqual(['B']);
    expect(errors).toEqual([{ line: 2, message: 'opening balance requires an owner' }]);
  });

  it('caps the column lengths the API relies on', () => {
    const text = 'label;kind;floor;ownerLastName\n'
      + `${'x'.repeat(51)};стан;1;Марков\n`
      + `A;стан;${'y'.repeat(21)};Марков\n`
      + `B;стан;1;${'z'.repeat(201)}\n`;
    const { rows, errors } = parseUnitImport(text);
    expect(rows).toEqual([]);
    expect(errors).toEqual([
      { line: 2, message: 'label is too long (max 50)' },
      { line: 3, message: 'floor is too long (max 20)' },
      { line: 4, message: 'ownerLastName is too long (max 200)' },
    ]);
  });

  it('reports an empty file instead of throwing', () => {
    expect(parseUnitImport('   \n\n')).toEqual({ rows: [], errors: [{ line: 1, message: 'empty file' }] });
  });
});
