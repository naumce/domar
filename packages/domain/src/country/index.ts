import { mkPack } from './mk.js';
import type { CountryCode, CountryPack } from './types.js';

export * from './types.js';
export { mkPack };

const packs: Record<CountryCode, CountryPack> = { mk: mkPack };

export function getCountryPack(code: CountryCode): CountryPack {
  return packs[code];
}
