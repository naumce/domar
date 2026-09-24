import { type Db, schema } from '@domar/db';
import type { TenantContext } from '../tenant-context.js';

export interface EmailLogEntry {
  to: string;
  subject: string;
  template: string;
  refType: string;
  refId?: string | null | undefined;
  status: 'sent' | 'failed';
  error?: string | null | undefined;
  sentAt?: Date | null | undefined;
}

/** Runs inside the caller's transaction, alongside the audit row for the same delivery attempt. */
export async function logEmail(tx: Db, ctx: TenantContext, e: EmailLogEntry) {
  const [row] = await tx.insert(schema.emailLog).values({
    tenantId: ctx.tenantId,
    toAddress: e.to,
    subject: e.subject,
    template: e.template,
    refType: e.refType,
    refId: e.refId ?? null,
    status: e.status,
    error: e.error ?? null,
    sentAt: e.sentAt ?? (e.status === 'sent' ? new Date() : null),
  }).returning();
  return row!;
}
