import { type Db, schema } from '@domar/db';
import { isServiceDue } from '@domar/domain';
import { and, asc, eq } from 'drizzle-orm';
import type { TenantContext } from '../../tenant-context.js';

export interface NewPeriodLine {
  serviceId: string | null;
  description: string;
  pricing: 'fixed_per_unit' | 'per_m2' | 'shared_total';
  quantity: string;
  unitPriceMinor: number;
  taxRateBp: number;
  appliesTo: string[];
  fund: 'regular' | 'reserve';
  source: 'auto' | 'manual';
  note: string | null;
  sortOrder: number;
}

export async function buildAutoLines(db: Db, ctx: TenantContext, buildingId: string, period: string): Promise<NewPeriodLine[]> {
  const BS = schema.buildingServices; const S = schema.services;
  const rows = await db.select({ bs: BS, s: S, rateBp: schema.taxRates.rateBp }).from(BS)
    .innerJoin(S, eq(S.id, BS.serviceId)).leftJoin(schema.taxRates, eq(schema.taxRates.id, S.taxRateId))
    .where(and(eq(BS.tenantId, ctx.tenantId), eq(BS.buildingId, buildingId), eq(BS.isActive, true), eq(S.isActive, true)))
    // ordered by attach order (not service name) so auto lines reflect the order services were attached to the building
    .orderBy(asc(BS.createdAt));
  return rows
    .filter((r) => isServiceDue(period, { frequency: r.bs.frequency, intervalMonths: r.bs.intervalMonths, startsPeriod: r.bs.startsPeriod, endsPeriod: r.bs.endsPeriod }))
    .map((r, i) => ({
      serviceId: r.s.id, description: r.s.name, pricing: r.bs.pricing ?? r.s.pricing, quantity: '1', unitPriceMinor: r.bs.priceMinor ?? r.s.defaultPriceMinor,
      taxRateBp: r.rateBp ?? 0, appliesTo: r.s.appliesTo, fund: 'regular', source: 'auto', note: null, sortOrder: i * 10,
    }));
}
