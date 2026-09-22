import type { ParsedStatementLine, StatementParser } from './types.js';

function splitCsvLine(line: string, delim: string): string[] {
  const out: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === delim) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function header(text: string): { delim: string; cols: string[] } | null {
  const first = text.split(/\r?\n/).find((l) => l.trim() !== '');
  if (!first) return null;
  const delim = (first.split(';').length >= first.split(',').length) ? ';' : ',';
  const cols = splitCsvLine(first, delim).map((c) => c.toLowerCase());
  return cols.includes('date') && cols.includes('amount') ? { delim, cols } : null;
}

function isoDate(s: string): string | null {
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}
const validDate = (iso: string) => { const d = new Date(`${iso}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(iso); };

export const csvParser: StatementParser = {
  id: 'csv',
  detect(text) { return header(text) !== null; },
  parse(text, amount) {
    const warnings: string[] = []; const lines: ParsedStatementLine[] = [];
    const h = header(text);
    if (!h) return { format: 'csv', accountNumber: null, lines, warnings: ['missing date/amount header'] };
    const rows = text.split(/\r?\n/).filter((l) => l.trim() !== '').slice(1);
    const idx = (name: string) => h.cols.indexOf(name);
    rows.forEach((row, n) => {
      const cells = splitCsvLine(row, h.delim);
      const iso = isoDate(cells[idx('date')] ?? '');
      if (!iso || !validDate(iso)) { warnings.push(`row ${n + 2}: bad date`); return; }
      let amt: number;
      try { amt = amount(cells[idx('amount')] ?? ''); } catch { warnings.push(`row ${n + 2}: bad amount`); return; }
      lines.push({ bookedAt: iso, amountMinor: amt, reference: idx('reference') >= 0 ? (cells[idx('reference')] ?? '') : '', counterparty: idx('counterparty') >= 0 ? (cells[idx('counterparty')] ?? '') : '', raw: row });
    });
    return { format: 'csv', accountNumber: null, lines, warnings };
  },
};
