import { describe, expect, it } from 'vitest';
import { calculatePeriod, type CalcInput } from '../src/calculation/index.js';

const input: CalcInput = {
  building: { id: 'b1', shareBasis: 'area' },
  units: [
    { id: 'A', label: '1', kind: 'apartment', areaM2: 50, ownershipShare: null, ownerContactId: 'O1', attachedToUnitId: null },
    { id: 'B', label: '2', kind: 'apartment', areaM2: 75, ownershipShare: null, ownerContactId: 'O2', attachedToUnitId: null },
    { id: 'C', label: 'L1', kind: 'commercial', areaM2: 100, ownershipShare: null, ownerContactId: 'O3', attachedToUnitId: null },
    { id: 'P1', label: 'P-1', kind: 'parking', areaM2: null, ownershipShare: null, ownerContactId: null, attachedToUnitId: 'A' },
    { id: 'S1', label: 'S-1', kind: 'storage', areaM2: 10, ownershipShare: null, ownerContactId: null, attachedToUnitId: null },
  ],
  lines: [
    { id: 'l-clean', kind: 'service', description: 'Чистење', pricing: 'fixed_per_unit', quantity: 1, unitPriceMinor: 30000, taxRateBp: 1800, appliesTo: ['apartment', 'commercial'], fund: 'regular' },
    { id: 'l-lift', kind: 'service', description: 'Лифт', pricing: 'shared_total', quantity: 1, unitPriceMinor: 600000, taxRateBp: 1800, appliesTo: [], fund: 'regular' },
    { id: 'l-park', kind: 'manual', description: 'Осветлување паркинг', pricing: 'fixed_per_unit', quantity: 1, unitPriceMinor: 2000, taxRateBp: 1800, appliesTo: ['parking'], fund: 'regular' },
    { id: 'l-rf', kind: 'reserve_fund', description: 'Резервен фонд', pricing: 'per_m2', quantity: 1, unitPriceMinor: 1000, taxRateBp: 0, appliesTo: ['apartment', 'commercial'], fund: 'reserve' },
    { id: 'l-fee', kind: 'management_fee', description: 'Управување', pricing: 'fixed_per_unit', quantity: 1, unitPriceMinor: 15000, taxRateBp: 1800, appliesTo: ['apartment', 'commercial'], fund: 'regular' },
  ],
  previousBalances: { O1: 5000, O3: -1200 },
  reserveFundBuildingBalanceMinor: 3500000,
};

describe('calculatePeriod', () => {
  const result = calculatePeriod(input);
  const byOwner = Object.fromEntries(result.invoices.map((i) => [i.contactId, i]));

  it('produces one invoice per billing owner, in first-appearance order', () => {
    expect(result.invoices.map((i) => i.contactId)).toEqual(['O1', 'O2', 'O3']);
  });

  it('folds an attached parking unit into the apartment owner invoice', () => {
    expect(byOwner.O1!.unitIds).toEqual(['A', 'P1']);
    const park = byOwner.O1!.lines.find((l) => l.lineId === 'l-park')!;
    expect(park).toMatchObject({ unitId: 'P1', ownerNetMinor: 2000, ownerTaxMinor: 360, ownerGrossMinor: 2360, buildingWideNetMinor: 2000 });
  });

  it('splits a shared total by area with largest remainder and reports building-wide amounts', () => {
    const liftA = byOwner.O1!.lines.find((l) => l.lineId === 'l-lift')!;
    const liftB = byOwner.O2!.lines.find((l) => l.lineId === 'l-lift')!;
    const liftC = byOwner.O3!.lines.find((l) => l.lineId === 'l-lift')!;
    expect([liftA.ownerNetMinor, liftB.ownerNetMinor, liftC.ownerNetMinor]).toEqual([127660, 191489, 255319]);
    expect([liftA.ownerTaxMinor, liftB.ownerTaxMinor, liftC.ownerTaxMinor]).toEqual([22979, 34468, 45957]);
    expect(liftA.buildingWideNetMinor).toBe(600000);
  });

  it('charges the reserve fund per m² tax-free on the reserve fund', () => {
    const rf = byOwner.O2!.lines.find((l) => l.lineId === 'l-rf')!;
    expect(rf).toMatchObject({ kind: 'reserve_fund', fund: 'reserve', ownerNetMinor: 75000, ownerTaxMinor: 0, ownerGrossMinor: 75000, buildingWideNetMinor: 225000 });
  });

  it('totals each invoice and carries the previous balance', () => {
    expect(byOwner.O1).toMatchObject({ subtotalMinor: 224660, taxMinor: 31439, totalMinor: 256099, previousBalanceMinor: 5000, amountDueMinor: 261099 });
    expect(byOwner.O2).toMatchObject({ subtotalMinor: 311489, taxMinor: 42568, totalMinor: 354057, previousBalanceMinor: 0, amountDueMinor: 354057 });
    expect(byOwner.O3).toMatchObject({ subtotalMinor: 400319, taxMinor: 54057, totalMinor: 454376, previousBalanceMinor: -1200, amountDueMinor: 453176 });
  });

  it('snapshots the reserve fund building balance on every invoice', () => {
    expect(result.invoices.every((i) => i.reserveFundBuildingBalanceMinor === 3500000)).toBe(true);
  });

  it('warns about missing area and unowned units, and skips unowned units', () => {
    expect(result.warnings).toContainEqual({ code: 'missing_area', unitId: 'P1', lineId: 'l-lift' });
    expect(result.warnings).toContainEqual({ code: 'no_owner', unitId: 'S1' });
    expect(result.skippedUnits).toEqual([{ unitId: 'S1', reason: 'no_owner' }]);
    expect(result.invoices.some((i) => i.unitIds.includes('S1'))).toBe(false);
  });

  it('is deterministic', () => {
    expect(calculatePeriod(input)).toEqual(result);
  });

  it('skips a shared line whose covered units have no weight and warns', () => {
    const r = calculatePeriod({ ...input, lines: [{ id: 'x', kind: 'manual', description: 'x', pricing: 'shared_total', quantity: 1, unitPriceMinor: 1000, taxRateBp: 0, appliesTo: ['parking'], fund: 'regular' }] });
    expect(r.warnings).toContainEqual({ code: 'no_weight', lineId: 'x' });
    expect(r.invoices).toEqual([]);
  });

  it('uses equal and custom share bases', () => {
    const equal = calculatePeriod({ ...input, building: { id: 'b1', shareBasis: 'equal' }, lines: [input.lines[1]!] });
    // 5 covered units incl. P1 and S1; 600000/5 = 120000 each; S1 skipped (no owner)
    expect(equal.invoices.map((i) => i.lines.reduce((s, l) => s + l.ownerNetMinor, 0))).toEqual([240000, 120000, 120000]); // O1 gets A + P1
    const custom = calculatePeriod({
      ...input,
      building: { id: 'b1', shareBasis: 'custom' },
      units: input.units.map((u) => ({ ...u, ownershipShare: u.id === 'A' ? 0.5 : u.id === 'B' ? 0.3 : u.id === 'C' ? 0.2 : null })),
      lines: [{ ...input.lines[1]!, appliesTo: ['apartment', 'commercial'] }],
    });
    expect(custom.invoices.map((i) => i.lines[0]!.ownerNetMinor)).toEqual([300000, 180000, 120000]);
  });
});
