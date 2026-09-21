import { allocateLargestRemainder, applyTaxBp, mulMinor } from '../money.js';
import type { CalcInput, CalcLine, CalcResult, CalcUnit, CalcWarning, InvoiceDraft, InvoiceDraftLine } from './types.js';

/**
 * - `quantity` is a plain multiplier applied to the unit price: fixed_per_unit → price × quantity;
 *   per_m2 → price × quantity × unit area; shared_total → price × quantity, split across covered units.
 * - Tax is rounded per unit-line (via applyTaxBp), so an owner's summed per-line tax can differ by a
 *   minor unit or two from applying the tax rate once to the building-wide net — that's rounding, not a bug.
 * - Zero-amount unit-lines (ownerNetMinor === 0) are omitted from invoices; a 0,00 line has no place on
 *   an invoice. Building-wide sums (buildingWideNetMinor) still include every covered unit, zero or not.
 */

/** The owner who receives a unit's charges: the attach target's owner when attached, else the unit's own owner. */
function billingOwner(unit: CalcUnit, byId: Map<string, CalcUnit>): string | null {
  if (unit.attachedToUnitId) {
    const target = byId.get(unit.attachedToUnitId);
    if (target) return target.ownerContactId;
  }
  return unit.ownerContactId;
}

function covers(line: CalcLine, unit: CalcUnit): boolean {
  return line.appliesTo.length === 0 || line.appliesTo.includes(unit.kind);
}

/** Net amount per covered unit for one line, in unit order. Pushes warnings. */
function perUnitNet(line: CalcLine, units: CalcUnit[], shareBasis: CalcInput['building']['shareBasis'], warnings: CalcWarning[]): number[] {
  switch (line.pricing) {
    case 'fixed_per_unit':
      return units.map(() => mulMinor(line.unitPriceMinor, line.quantity));
    case 'per_m2':
      return units.map((u) => {
        if (u.areaM2 === null) {
          warnings.push({ code: 'missing_area', unitId: u.id, lineId: line.id });
          return 0;
        }
        return mulMinor(line.unitPriceMinor, line.quantity * u.areaM2);
      });
    case 'shared_total': {
      const total = mulMinor(line.unitPriceMinor, line.quantity);
      const weights = units.map((u) => {
        if (shareBasis === 'equal') return 1;
        if (shareBasis === 'area') {
          if (u.areaM2 === null) {
            warnings.push({ code: 'missing_area', unitId: u.id, lineId: line.id });
            return 0;
          }
          return u.areaM2;
        }
        if (u.ownershipShare === null) {
          warnings.push({ code: 'missing_share', unitId: u.id, lineId: line.id });
          return 0;
        }
        return u.ownershipShare;
      });
      const sumW = weights.reduce((a, b) => a + b, 0);
      if (sumW <= 0) {
        warnings.push({ code: 'no_weight', lineId: line.id });
        return units.map(() => 0);
      }
      return allocateLargestRemainder(total, weights);
    }
  }
}

export function calculatePeriod(input: CalcInput): CalcResult {
  const warnings: CalcWarning[] = [];
  const byId = new Map<string, CalcUnit>();
  for (const u of input.units) {
    if (byId.has(u.id)) throw new RangeError(`duplicate unit id: ${u.id}`);
    byId.set(u.id, u);
  }
  const ownerOf = new Map(input.units.map((u) => [u.id, billingOwner(u, byId)]));

  const skipped: CalcResult['skippedUnits'] = [];
  for (const u of input.units) {
    if (ownerOf.get(u.id) !== null) continue;
    if (u.attachedToUnitId) {
      const target = byId.get(u.attachedToUnitId);
      if (target && target.ownerContactId === null) {
        warnings.push({ code: 'target_no_owner', unitId: u.id, targetUnitId: target.id });
        skipped.push({ unitId: u.id, reason: 'target_no_owner' });
        continue;
      }
    }
    warnings.push({ code: 'no_owner', unitId: u.id });
    skipped.push({ unitId: u.id, reason: 'no_owner' });
  }

  // contactId -> draft, insertion order = first appearance over lines then units
  const drafts = new Map<string, InvoiceDraft>();
  const draftFor = (contactId: string): InvoiceDraft => {
    let d = drafts.get(contactId);
    if (!d) {
      d = { contactId, unitIds: [], lines: [], subtotalMinor: 0, taxMinor: 0, totalMinor: 0, previousBalanceMinor: input.previousBalances[contactId] ?? 0, amountDueMinor: 0, reserveFundBuildingBalanceMinor: input.reserveFundBuildingBalanceMinor };
      drafts.set(contactId, d);
    }
    return d;
  };

  // Pre-register owners in unit order so invoice order is stable (O1, O2, O3 ...)
  for (const u of input.units) {
    const owner = ownerOf.get(u.id);
    if (owner) {
      const d = draftFor(owner);
      if (!d.unitIds.includes(u.id)) d.unitIds.push(u.id);
    }
  }

  for (const line of input.lines) {
    const covered = input.units.filter((u) => covers(line, u));
    if (covered.length === 0) {
      warnings.push({ code: 'no_units', lineId: line.id });
      continue;
    }
    const nets = perUnitNet(line, covered, input.building.shareBasis, warnings);
    const buildingWideNetMinor = nets.reduce((a, b) => a + b, 0);
    covered.forEach((u, i) => {
      const owner = ownerOf.get(u.id);
      if (!owner) return; // skipped unit: share computed for building-wide, not invoiced
      const ownerNetMinor = nets[i]!;
      if (ownerNetMinor === 0) return; // a 0,00 line has no place on the invoice
      const { taxMinor, grossMinor } = applyTaxBp(ownerNetMinor, line.taxRateBp);
      const dl: InvoiceDraftLine = {
        lineId: line.id, kind: line.kind, description: line.description, fund: line.fund, unitId: u.id, unitLabel: u.label,
        buildingWideNetMinor, ownerNetMinor, taxRateBp: line.taxRateBp, ownerTaxMinor: taxMinor, ownerGrossMinor: grossMinor,
      };
      const d = draftFor(owner);
      d.lines.push(dl);
      d.subtotalMinor += ownerNetMinor;
      d.taxMinor += taxMinor;
    });
  }

  const invoices = [...drafts.values()]
    .filter((d) => d.lines.length > 0)
    .map((d) => {
      d.totalMinor = d.subtotalMinor + d.taxMinor;
      d.amountDueMinor = d.totalMinor + d.previousBalanceMinor;
      return d;
    });

  return { invoices, warnings, skippedUnits: skipped };
}
