import { z } from 'zod';

export const idParam = z.object({ id: z.string().uuid() });
export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export const nullableStr = (max = 500) => z.string().max(max).nullable().optional();

/** Drops explicit-undefined keys so the result satisfies exactOptionalPropertyTypes when spread into drizzle's `.set()`. */
export function stripUndefined<P extends Record<string, unknown>>(obj: P): { [K in keyof P]?: Exclude<P[K], undefined> } {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as { [K in keyof P]?: Exclude<P[K], undefined> };
}
