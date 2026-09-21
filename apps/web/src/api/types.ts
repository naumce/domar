export interface User { id: string; email: string; firstName: string; lastName: string; role: 'owner' | 'accountant' | 'technician' | 'readonly' }
export interface Tenant { id: string; slug: string; name: string; countryCode: string; currency: string; locale: string }
export interface TaxRate { id: string; name: string; rateBp: number; isDefault: boolean; isActive: boolean }
export interface Contact { id: string; kind: 'person' | 'company'; firstName: string; lastName: string; companyNumber: string | null; vatNumber: string | null; email: string | null; phone: string | null; address: string | null; notes: string | null }
export interface Building { id: string; name: string; address: string; city: string; postalCode: string; countryCode: string; representativeContactId: string | null; regularFundAccount: string | null; reserveFundAccount: string | null; shareBasis: 'area' | 'equal' | 'custom'; unitCount?: number }
export type UnitKind = 'apartment' | 'commercial' | 'parking' | 'storage' | 'other';
export interface Unit { id: string; buildingId: string; label: string; floor: string | null; kind: UnitKind; areaM2: number | null; ownershipShare: number | null; ownerContactId: string | null; attachedToUnitId: string | null; owner: { id: string; firstName: string; lastName: string } | null }
