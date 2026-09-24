import type { schema } from '@domar/db';

/** One (tenant, contact) pair the signed-in owner is allowed to read. */
export interface PortalLink {
  tenantId: string;
  contactId: string;
}

/**
 * What a portal handler gets instead of a `TenantContext` (spec §19.6). A tenant id only ever
 * appears after a link has been resolved, and only inside `portal/repo.ts`.
 */
export interface PortalContext {
  ownerAccountId: string;
  links: PortalLink[];
}

declare module 'fastify' {
  interface FastifyRequest {
    portal: PortalContext | null;
    ownerSession: { token: string; account: typeof schema.ownerAccounts.$inferSelect } | null;
  }
}
