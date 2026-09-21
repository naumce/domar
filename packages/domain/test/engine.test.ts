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

  it('omits zero-amount lines from invoices', () => {
    // P1 (attached to A, billed to O1) has no area, so its area-based lift share floors to 0.
    expect(byOwner.O1!.lines.some((l) => l.lineId === 'l-lift' && l.unitId === 'P1')).toBe(false);
    expect(result.invoices.flatMap((i) => i.lines).some((l) => l.ownerNetMinor === 0)).toBe(false);
  });

  it('applies quantity as a multiplier before per-unit or shared-total splitting', () => {
    const twoApartments: CalcInput = {
      building: { id: 'b1', shareBasis: 'area' },
      units: [
        { id: 'A', label: '1', kind: 'apartment', areaM2: 50, ownershipShare: null, ownerContactId: 'O1', attachedToUnitId: null },
        { id: 'B', label: '2', kind: 'apartment', areaM2: 50, ownershipShare: null, ownerContactId: 'O2', attachedToUnitId: null },
      ],
      lines: [],
      previousBalances: {},
      reserveFundBuildingBalanceMinor: 0,
    };

    const perM2 = calculatePeriod({
      ...twoApartments,
      lines: [{ id: 'l1', kind: 'service', description: 'x', pricing: 'per_m2', quantity: 2, unitPriceMinor: 1000, taxRateBp: 0, appliesTo: ['apartment'], fund: 'regular' }],
    });
    expect(perM2.invoices.find((i) => i.contactId === 'O1')!.lines[0]!.ownerNetMinor).toBe(100000); // 1000 * 2 * 50

    const shared = calculatePeriod({
      ...twoApartments,
      lines: [{ id: 'l2', kind: 'service', description: 'y', pricing: 'shared_total', quantity: 2, unitPriceMinor: 300000, taxRateBp: 0, appliesTo: ['apartment'], fund: 'regular' }],
    });
    const sharedA = shared.invoices.find((i) => i.contactId === 'O1')!.lines[0]!;
    const sharedB = shared.invoices.find((i) => i.contactId === 'O2')!.lines[0]!;
    expect([sharedA.ownerNetMinor, sharedB.ownerNetMinor]).toEqual([300000, 300000]); // total 600000 split evenly by equal area
  });

  it('skips an attached unit whose target exists but has no owner, distinctly from no_owner', () => {
    const r = calculatePeriod({
      building: { id: 'b1', shareBasis: 'area' },
      units: [
        { id: 'A', label: '1', kind: 'apartment', areaM2: 50, ownershipShare: null, ownerContactId: null, attachedToUnitId: null },
        { id: 'P1', label: 'P-1', kind: 'parking', areaM2: null, ownershipShare: null, ownerContactId: 'OP', attachedToUnitId: 'A' },
      ],
      lines: [{ id: 'l1', kind: 'manual', description: 'x', pricing: 'fixed_per_unit', quantity: 1, unitPriceMinor: 1000, taxRateBp: 0, appliesTo: ['parking'], fund: 'regular' }],
      previousBalances: {},
      reserveFundBuildingBalanceMinor: 0,
    });
    expect(r.warnings).toContainEqual({ code: 'target_no_owner', unitId: 'P1', targetUnitId: 'A' });
    expect(r.skippedUnits).toContainEqual({ unitId: 'P1', reason: 'target_no_owner' });
    expect(r.invoices).toEqual([]);
  });

  it('warns no_units when a line covers no unit kind present in the building', () => {
    const r = calculatePeriod({ ...input, lines: [{ id: 'l-other', kind: 'manual', description: 'x', pricing: 'fixed_per_unit', quantity: 1, unitPriceMinor: 1000, taxRateBp: 0, appliesTo: ['other'], fund: 'regular' }] });
    expect(r.warnings).toContainEqual({ code: 'no_units', lineId: 'l-other' });
    expect(r.invoices).toEqual([]);
  });

  it('orders invoices by first owned unit, even when an unowned unit is listed first', () => {
    const r = calculatePeriod({
      ...input,
      units: [input.units[4]!, ...input.units.slice(0, 4)], // S1 (no owner) moved to the front
    });
    expect(r.invoices.map((i) => i.contactId)).toEqual(['O1', 'O2', 'O3']);
  });

  it('warns missing_share for a custom-basis unit with no configured share', () => {
    const r = calculatePeriod({
      ...input,
      building: { id: 'b1', shareBasis: 'custom' },
      units: input.units.map((u) => ({ ...u, ownershipShare: u.id === 'A' ? 0.5 : u.id === 'B' ? 0.5 : null })),
      lines: [{ ...input.lines[1]!, appliesTo: ['apartment', 'commercial'] }],
    });
    expect(r.warnings).toContainEqual({ code: 'missing_share', unitId: 'C', lineId: 'l-lift' });
  });

  it('conserves the building-wide net: owner shares plus skipped-unit shares equal buildingWideNetMinor', () => {
    // Give S1 (the only skipped unit in the fixture) an owner, so its share becomes visible on an
    // invoice instead of being dropped, then compare against the original run's owner totals.
    const withS1Owned = calculatePeriod({
      ...input,
      units: input.units.map((u) => (u.id === 'S1' ? { ...u, ownerContactId: 'O4' } : u)),
    });
    const sumByLine = (r: ReturnType<typeof calculatePeriod>, lineId: string) =>
      r.invoices.flatMap((i) => i.lines).filter((l) => l.lineId === lineId).reduce((s, l) => s + l.ownerNetMinor, 0);

    for (const line of input.lines) {
      const buildingWide = withS1Owned.invoices.flatMap((i) => i.lines).find((l) => l.lineId === line.id)?.buildingWideNetMinor;
      if (buildingWide === undefined) continue; // line billed nobody in either run
      const skippedShare = withS1Owned.invoices.find((i) => i.contactId === 'O4')?.lines.filter((l) => l.lineId === line.id).reduce((s, l) => s + l.ownerNetMinor, 0) ?? 0;
      expect(sumByLine(result, line.id) + skippedShare).toBe(buildingWide);
    }
  });

  it('throws on duplicate unit ids', () => {
    const dup: CalcInput = { ...input, units: [...input.units, { ...input.units[0]! }] };
    expect(() => calculatePeriod(dup)).toThrow(RangeError);
    expect(() => calculatePeriod(dup)).toThrow(/duplicate unit id/);
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
