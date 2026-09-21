export type UnitKind = 'apartment' | 'commercial' | 'parking' | 'storage' | 'other';
export type PricingModel = 'fixed_per_unit' | 'per_m2' | 'shared_total';
export type Fund = 'regular' | 'reserve';
export type ShareBasis = 'area' | 'equal' | 'custom';
export type LineKind = 'service' | 'manual' | 'reserve_fund' | 'management_fee';

export interface CalcUnit {
  id: string;
  label: string;
  kind: UnitKind;
  areaM2: number | null;
  ownershipShare: number | null;
  ownerContactId: string | null;
  attachedToUnitId: string | null;
}

export interface CalcLine {
  id: string;
  kind: LineKind;
  description: string;
  pricing: PricingModel;
  quantity: number;
  unitPriceMinor: number;
  taxRateBp: number;
  /** empty = applies to all unit kinds */
  appliesTo: UnitKind[];
  fund: Fund;
}

export interface CalcInput {
  building: { id: string; shareBasis: ShareBasis };
  units: CalcUnit[];
  lines: CalcLine[];
  /** outstanding owner balances before this period, by contact id (positive = owes) */
  previousBalances: Record<string, number>;
  reserveFundBuildingBalanceMinor: number;
}

export interface InvoiceDraftLine {
  lineId: string;
  kind: LineKind;
  description: string;
  fund: Fund;
  unitId: string;
  unitLabel: string;
  buildingWideNetMinor: number;
  ownerNetMinor: number;
  taxRateBp: number;
  ownerTaxMinor: number;
  ownerGrossMinor: number;
}

export interface InvoiceDraft {
  contactId: string;
  unitIds: string[];
  lines: InvoiceDraftLine[];
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  previousBalanceMinor: number;
  amountDueMinor: number;
  reserveFundBuildingBalanceMinor: number;
}

export type CalcWarning =
  | { code: 'missing_area'; unitId: string; lineId: string }
  | { code: 'missing_share'; unitId: string; lineId: string }
  | { code: 'no_owner'; unitId: string }
  | { code: 'target_no_owner'; unitId: string; targetUnitId: string }
  | { code: 'no_weight'; lineId: string }
  | { code: 'no_units'; lineId: string };

export interface CalcResult {
  invoices: InvoiceDraft[];
  warnings: CalcWarning[];
  skippedUnits: { unitId: string; reason: 'no_owner' | 'target_no_owner' }[];
}
