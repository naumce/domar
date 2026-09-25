import { z } from 'zod';

export const idParam = z.object({ id: z.string().uuid() });
export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export const nullableStr = (max = 500) => z.string().max(max).nullable().optional();
export const unitKindEnum = z.enum(['apartment', 'commercial', 'parking', 'storage', 'other']);
export const boolQuery = z.enum(['true', 'false']).transform((v) => v === 'true');
export const moneyMinor = z.number().int().min(0).max(1_000_000_000_000);
export const periodStr = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'YYYY-MM');
export const dedupe = <T>(xs: T[]): T[] => [...new Set(xs)];

/** A civil day of the tenant's zone, never UTC — shared by every report/export that prints one. */
export function dayIn(timeZone: string): (x: Date | string | null) => string {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return (x) => (x === null ? '' : fmt.format(new Date(x)));
}

/** Drops explicit-undefined keys so the result satisfies exactOptionalPropertyTypes when spread into drizzle's `.set()`. */
export function stripUndefined<P extends Record<string, unknown>>(obj: P): { [K in keyof P]?: Exclude<P[K], undefined> } {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as { [K in keyof P]?: Exclude<P[K], undefined> };
}
