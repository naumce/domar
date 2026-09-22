import type { ParsedStatementLine, StatementParser } from './types.js';

const TAG = /^:(\d{2}[A-Z]?):(.*)$/;
const TX = /^(\d{6})(\d{4})?(RC|RD|C|D)([A-Z])?(\d+(?:,\d*)?)(N|F)?([A-Z0-9]{3})?(.*)$/;

/** Converts a SWIFT YYMMDD value date to ISO, validating it round-trips through Date (rejects e.g. month 13 or day 40). */
function yymmdd(s: string): string | null {
  const yy = Number(s.slice(0, 2));
  const year = yy < 70 ? 2000 + yy : 1900 + yy;
  const iso = `${year}-${s.slice(2, 4)}-${s.slice(4, 6)}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(iso) ? iso : null;
}

/** Splits :86: text into purpose (?20-?29) and counterparty name (?32/?33) when the German ?-field convention is used. */
function details86(text: string): { purpose: string; counterparty: string } {
  if (!text.includes('?')) return { purpose: text.trim(), counterparty: '' };
  const fields = text.split('?').slice(1);
  let purpose = ''; let counterparty = '';
  for (const f of fields) {
    const code = f.slice(0, 2); const val = f.slice(2).trim();
    if (/^2\d$/.test(code)) purpose += (purpose ? ' ' : '') + val;
    else if (code === '32' || code === '33') counterparty += (counterparty ? ' ' : '') + val;
  }
  return { purpose, counterparty };
}

export const mt940Parser: StatementParser = {
  id: 'mt940',
  detect(text) { return /^:61:/m.test(text) || (/^:20:/m.test(text) && /^:25:/m.test(text)); },
  parse(text, amount) {
    const warnings: string[] = []; const lines: ParsedStatementLine[] = [];
    let accountNumber: string | null = null;
    // group into tag blocks (continuation lines belong to the previous tag)
    const blocks: { tag: string; text: string }[] = [];
    for (const rawLine of text.split(/\r?\n/)) {
      const m = TAG.exec(rawLine);
      if (m) blocks.push({ tag: m[1]!, text: m[2]! });
      else if (blocks.length && rawLine.trim() !== '' && rawLine.trim() !== '-') blocks[blocks.length - 1]!.text += '\n' + rawLine;
    }
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]!;
      if (b.tag === '25') accountNumber = b.text.trim() || null;
      if (b.tag !== '61') continue;
      const parts = b.text.split('\n');
      const first = parts[0]!.trim();
      // subfield 9 (additional info) may continue onto further physical lines of the same :61: block
      const continuation = parts.slice(1).map((l) => l.trim()).filter(Boolean);
      const m = TX.exec(first);
      if (!m) { warnings.push(`:61: line not understood: ${first.slice(0, 40)}`); continue; }
      const bookedAt = yymmdd(m[1]!);
      if (!bookedAt) { warnings.push(`:61: invalid value date: ${m[1]}`); continue; }
      const sign = m[3] === 'D' || m[3] === 'RC' ? -1 : 1;
      let amt: number;
      try { amt = amount(m[5]!.replace(/,$/, ',00')); } catch { warnings.push(`:61: amount not understood: ${m[5]}`); continue; }
      const rest = m[8] ?? '';
      const customerRef = rest.split('//')[0]!.trim();
      const next = blocks[i + 1];
      const info = next && next.tag === '86' ? details86(next.text.replace(/\n/g, ' ')) : { purpose: '', counterparty: '' };
      const referenceParts = [customerRef && customerRef !== 'NONREF' ? customerRef : '', ...continuation, info.purpose].filter(Boolean);
      lines.push({ bookedAt, amountMinor: sign * amt, reference: referenceParts.join(' ').trim(), counterparty: info.counterparty, raw: [first, ...continuation, next?.tag === '86' ? next.text : ''].filter(Boolean).join('\n') });
    }
    return { format: 'mt940', accountNumber, lines, warnings };
  },
};
