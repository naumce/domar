import { createHash } from 'node:crypto';
import { randomCode } from '../auth/password.js';

/** Eight characters is ~1.4e14 possibilities: long enough to dictate over the phone, short enough to type. */
export const INVITE_CODE_LENGTH = 8;

export function generateInviteCode(): string {
  return randomCode(INVITE_CODE_LENGTH);
}

/** Only this hash is stored; a database dump cannot be replayed into someone's portal account. */
export function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}
