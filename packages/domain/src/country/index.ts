import { mkPack } from './mk.js';
import type { CountryCode, CountryPack } from './types.js';

export * from './types.js';
export { mkPack };

const packs: Record<CountryCode, CountryPack> = { mk: mkPack };

/**
 * Total and case-insensitive: a caller only ever has a plain string from a database column or a
 * request body, never a value the compiler has actually narrowed to `CountryCode`, so this is the
 * one place that string is trusted to become one. An unrecognised code throws here, by name, rather
 * than handing a caller `undefined` to dereference (`pack.formatMoney(...)` and friends would throw
 * a far less useful error one line later).
 */
export function getCountryPack(code: string): CountryPack {
  const pack = packs[code.toLowerCase() as CountryCode];
  if (!pack) throw new Error(`unknown country pack: ${code}`);
  return pack;
}
