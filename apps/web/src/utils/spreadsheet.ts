import { splitCsvLine } from '@domar/domain';

/** Every cell as text, trimmed; fully empty rows dropped. */
function tidy(rows: unknown[][]): string[][] {
  return rows
    .map((r) => r.map((c) => String(c ?? '').trim()))
    .filter((r) => r.some((c) => c !== ''));
}

function readArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

/**
 * The first sheet of a workbook as text rows. SheetJS is ~7 MB, so it is imported only when a
 * spreadsheet is actually chosen (spec §20.1). `raw: false` returns each cell as the spreadsheet
 * displays it, so dates and amounts keep the formatting the operator sees.
 */
export async function readWorkbookRows(file: File): Promise<string[][]> {
  const { read, utils } = await import('xlsx');
  const wb = read(new Uint8Array(await readArrayBuffer(file)), { type: 'array' });
  const name = wb.SheetNames[0];
  const sheet = name ? wb.Sheets[name] : undefined;
  if (!sheet) return [];
  return tidy(utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '', blankrows: false }));
}

/** A delimited text file as rows, with the same `;`-over-`,` sniffing the parser uses. */
export function splitDelimitedRows(text: string): string[][] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const first = lines.find((l) => l.trim() !== '') ?? '';
  const delim = first.split(';').length >= first.split(',').length ? ';' : ',';
  return tidy(lines.filter((l) => l.trim() !== '').map((l) => splitCsvLine(l, delim)));
}

/**
 * Where this file's mapping is remembered. The headers are sorted, so a reordered file keeps its
 * mapping; the stored value maps a target field to a header *name*, so the reordering survives too.
 */
export function mappingKey(headers: string[]): string {
  const joined = headers.map((h) => h.trim().toLowerCase()).sort().join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `domar.importMapping.${(h >>> 0).toString(16).padStart(8, '0')}`;
}

export function loadMapping(headers: string[]): Record<string, string> {
  try {
    const raw = localStorage.getItem(mappingKey(headers));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function saveMapping(headers: string[], byField: Record<string, string>): void {
  try {
    localStorage.setItem(mappingKey(headers), JSON.stringify(byField));
  } catch {
    // A private window with storage disabled must still be able to import.
  }
}
