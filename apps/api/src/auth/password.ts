import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const N = 131072, R = 8, P = 1, LEN = 64, MAXMEM = 256 * 1024 * 1024;

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(plain, salt, LEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const [algo, nStr, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt' || !nStr || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = await scryptAsync(plain, Buffer.from(saltB64, 'base64url'), expected.length, { N: Number(nStr), r: R, p: P, maxmem: MAXMEM });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** No I, O, l, 0 or 1: a code or temporary password gets read off a screen and typed by hand. */
export const UNAMBIGUOUS_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const TEMP_LENGTH = 16;

/** `length` characters drawn uniformly from UNAMBIGUOUS_ALPHABET (rejection sampling, so no modulo bias). */
export function randomCode(length: number): string {
  const n = UNAMBIGUOUS_ALPHABET.length;
  const limit = 256 - (256 % n);
  let out = '';
  while (out.length < length) {
    for (const b of randomBytes(length)) {
      if (b >= limit) continue;
      out += UNAMBIGUOUS_ALPHABET[b % n];
      if (out.length === length) break;
    }
  }
  return out;
}

export function generateTemporaryPassword(): string {
  return randomCode(TEMP_LENGTH);
}

/**
 * A valid scrypt hash of a fixed throwaway string, verified when no user or owner account matches so
 * that an unknown email costs the same time as a wrong password. A literal, not a call: hashing at
 * module load would pay the full scrypt cost on every boot.
 */
export const DUMMY_PASSWORD_HASH = 'scrypt$131072$__eKji6dtUjRjS7WEtNFcA$QAXfu0bP0eMWJxlBTJLWPKi0pjL9X9WcBkNcdJAhjGJ_vMfmV1ybdlb8yxB9NeMzeV8LjRVkcFne7z00BVBhOA';
