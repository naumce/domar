import { type Db, schema } from '@domar/db';
import type { TenantContext } from './tenant-context.js';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | undefined;
  before?: unknown;
  after?: unknown;
}

export async function writeAudit(db: Db, ctx: TenantContext, entry: AuditEntry): Promise<void> {
  await db.insert(schema.auditLogs).values({
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
  });
}
