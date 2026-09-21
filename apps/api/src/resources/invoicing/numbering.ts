import { type Db, schema } from '@domar/db';
import { sql } from 'drizzle-orm';
import type { TenantContext } from '../../tenant-context.js';

export function formatInvoiceNumber(seq: number, prefix: string, suffix: string, year: number): string {
  return `${prefix}${String(seq).padStart(4, '0')}${suffix.replaceAll('{year}', String(year))}`;
}

/** Atomically reserves the next sequence number for the tenant and year. */
export async function nextInvoiceNumber(db: Db, ctx: TenantContext, year: number, prefix: string, suffix: string): Promise<string> {
  const S = schema.invoiceSequences;
  const [row] = await db.insert(S).values({ tenantId: ctx.tenantId, year, next: 2 })
    .onConflictDoUpdate({ target: [S.tenantId, S.year], set: { next: sql`${S.next} + 1` } })
    .returning({ next: S.next });
  return formatInvoiceNumber(row!.next - 1, prefix, suffix, year);
}
