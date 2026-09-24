import { z } from 'zod';
import { dedupe, moneyMinor, nullableStr, unitKindEnum } from '../common.js';

export const fundEnum = z.enum(['regular', 'reserve']);
export const settingOut = z.object({ id: z.string(), buildingId: z.string(), basis: z.enum(['per_unit', 'per_m2']), amountMinor: z.number().int(), appliesTo: z.array(unitKindEnum), active: z.boolean(), updatedAt: z.date().or(z.string()) });
export const stateOut = z.object({ setting: settingOut.nullable(), balanceMinor: z.number().int(), contributionsBilledMinor: z.number().int() });
export const settingPut = z.object({ basis: z.enum(['per_unit', 'per_m2']), amountMinor: moneyMinor, appliesTo: z.array(unitKindEnum).max(5).default([]).transform(dedupe), active: z.boolean() });
export const openingBalanceBody = z.object({ amountMinor: z.number().int().min(-1_000_000_000_000).max(1_000_000_000_000), note: nullableStr(500) });
export const postingOut = z.object({ id: z.string(), kind: z.enum(['charge', 'payment', 'expense', 'adjustment', 'opening']), fund: fundEnum, amountMinor: z.number().int(), refType: z.string(), refId: z.string().nullable(), bookedAt: z.date().or(z.string()) });
export const expenseOut = z.object({ id: z.string(), buildingId: z.string(), fund: fundEnum, description: z.string(), supplierText: z.string().nullable(), supplierId: z.string().nullable(), documentId: z.string().nullable(), amountMinor: z.number().int(), paidAt: z.date().or(z.string()), voidedAt: z.date().or(z.string()).nullable(), voidReason: z.string().nullable(), createdAt: z.date().or(z.string()) });
export const expenseCreate = z.object({ fund: fundEnum, description: z.string().min(1).max(500), supplierText: nullableStr(200), supplierId: z.string().uuid().nullable().optional(), documentId: z.string().uuid().nullable().optional(), amountMinor: z.number().int().min(1).max(1_000_000_000_000), paidAt: z.string().datetime() });
export const voidBody = z.object({ reason: z.string().min(1).max(500) });
export const transactionOut = z.object({ id: z.string(), kind: z.enum(['charge', 'payment', 'expense', 'adjustment', 'opening']), fund: fundEnum, amountMinor: z.number().int(), refType: z.string(), refId: z.string().nullable(), bookedAt: z.date().or(z.string()), description: z.string().nullable() });
