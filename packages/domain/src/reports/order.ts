/**
 * What a report sorts by. Names and descriptions are read by a person, so they sort in the pack's
 * alphabet, where Ќ follows Т; ids, keys and ISO timestamps are machine strings and sort as plain
 * code units, which keeps the order of a filed report the same on every machine and every locale.
 */
export const byName = (a: string, b: string): number => a.localeCompare(b, 'mk');

export const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
