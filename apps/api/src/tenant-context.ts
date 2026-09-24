import type { schema } from '@domar/db';

export type UserRole = (typeof schema.userRole.enumValues)[number];

export interface TenantContext {
  tenantId: string;
  /** null for the nightly job, which acts for no user; `audit_logs.user_id` is nullable. */
  userId: string | null;
  role: UserRole;
}

declare module 'fastify' {
  interface FastifyRequest { ctx: TenantContext | null }
}
