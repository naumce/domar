import { z } from 'zod';
import { pageQuery, periodStr } from '../common.js';
import { fundEnum } from '../reserve-fund/schema.js';

export const invoiceStatusEnum = z.enum(['draft', 'published', 'partially_paid', 'paid', 'cancelled']);
const dt = () => z.date().or(z.string()).nullable();
export const invoiceRowOut = z.object({
  id: z.string(), periodId: z.string(), buildingId: z.string(), contactId: z.string(), number: z.string().nullable(), status: invoiceStatusEnum, currency: z.string(),
  unitIds: z.array(z.string()), subtotalMinor: z.number().int(), taxMinor: z.number().int(), totalMinor: z.number().int(), previousBalanceMinor: z.number().int(),
  amountDueMinor: z.number().int(), reserveFundBuildingBalanceMinor: z.number().int(), issuedAt: dt(), dueAt: dt(), publishedAt: dt(), period: z.string(),
  contact: z.object({ id: z.string(), firstName: z.string(), lastName: z.string() }), building: z.object({ id: z.string(), name: z.string() }), createdAt: z.date().or(z.string()),
});
export const invoiceLineOut = z.object({
  id: z.string(), kind: z.enum(['service', 'manual', 'reserve_fund', 'management_fee']), description: z.string(), fund: fundEnum, unitId: z.string().nullable(), unitLabel: z.string(),
  buildingWideNetMinor: z.number().int(), ownerNetMinor: z.number().int(), taxRateBp: z.number().int(), ownerTaxMinor: z.number().int(), ownerGrossMinor: z.number().int(), sortOrder: z.number().int(),
});
export const invoiceDetailOut = invoiceRowOut.extend({
  lines: z.array(invoiceLineOut),
  contact: z.object({ id: z.string(), kind: z.enum(['person', 'company']), firstName: z.string(), lastName: z.string(), email: z.string().nullable(), address: z.string().nullable(), companyNumber: z.string().nullable(), vatNumber: z.string().nullable() }),
  building: z.object({ id: z.string(), name: z.string(), address: z.string(), city: z.string(), postalCode: z.string(), regularFundAccount: z.string().nullable(), reserveFundAccount: z.string().nullable() }),
});
export const invoiceListQuery = pageQuery.extend({ buildingId: z.string().uuid().optional(), period: periodStr.optional(), status: invoiceStatusEnum.optional(), contactId: z.string().uuid().optional() });
