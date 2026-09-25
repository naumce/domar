import type { FastifyReply, FastifyRequest } from 'fastify';
import { forbidden, unauthorized } from '../errors.js';
import type { UserRole } from '../tenant-context.js';

export function requireRole(...roles: UserRole[]) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.ctx) throw unauthorized();
    if (!roles.includes(req.ctx.role)) throw forbidden();
  };
}

export const WRITE_ROLES: UserRole[] = ['owner', 'accountant'];

/** Spec §10: the roles that may work a maintenance request. A technician is scoped again in the repo. */
export const MAINTENANCE_ROLES: UserRole[] = ['owner', 'accountant', 'technician'];
