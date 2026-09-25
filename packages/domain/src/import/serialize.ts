import { IMPORT_FIELDS, type ImportField } from './units.js';

/** The header `parseUnitImport` reads back, and the one the downloadable template carries. */
export const CANONICAL_HEADER = 'број;кат;тип;површина;удел;име;презиме;е-пошта;телефон;почетно салдо';

/** A row with every target column present and empty; callers fill in what they mapped. */
export function emptyImportRow(): Record<ImportField, string> {
  return Object.fromEntries(IMPORT_FIELDS.map((f) => [f, ''])) as Record<ImportField, string>;
}

/**
 * A cell's own line breaks are flattened to one space before quoting: `parseUnitImport` splits the
 * file into lines before it splits a line into cells, so a quoted newline would cut one unit in two.
 * Exported because every `;` file this product writes — the units template and the Art. 30 data
 * export — must quote a cell the same way.
 */
export function csvCell(value: string): string {
  const flat = value.replace(/\r\n|[\r\n]/g, ' ');
  return /[;"]/.test(flat) ? `"${flat.replace(/"/g, '""')}"` : flat;
}

/** Mapped cells → the canonical `;` CSV the units import accepts. The inverse of `parseUnitImport`. */
export function rowsToCanonicalCsv(rows: Record<ImportField, string>[]): string {
  const lines = rows.map((r) => IMPORT_FIELDS.map((f) => csvCell(r[f] ?? '')).join(';'));
  return [CANONICAL_HEADER, ...lines, ''].join('\n');
}
