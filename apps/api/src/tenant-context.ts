import type { schema } from '@domar/db';

export type UserRole = (typeof schema.userRole.enumValues)[number];

export interface TenantContext {
  tenantId: string;
  userId: string;
  role: UserRole;
}

declare module 'fastify' {
  interface FastifyRequest { ctx: TenantContext | null }
}
