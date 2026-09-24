export * from './types.js';
export { mt940Parser } from './mt940.js';
export { csvParser, splitCsvLine } from './csv.js';
export * from './matching.js';
import type { CountryPack } from '../country/types.js';
import type { StatementParser } from './types.js';
export function detectStatementParser(text: string, pack: Pick<CountryPack, 'statementParsers'>): StatementParser | null {
  return pack.statementParsers.find((p) => p.detect(text)) ?? null;
}
