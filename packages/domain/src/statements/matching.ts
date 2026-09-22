import type { ParsedStatementLine } from './types.js';

const CYR: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', ѓ: 'gj', е: 'e', ж: 'z', з: 'z', ѕ: 'dz', и: 'i', ј: 'j', к: 'k', л: 'l', љ: 'lj', м: 'm', н: 'n', њ: 'nj', о: 'o', п: 'p', р: 'r', с: 's', т: 't', ќ: 'kj', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'c', џ: 'dz', ш: 's' };

export function transliterate(s: string): string {
  return [...s.toLowerCase()].map((c) => CYR[c] ?? c).join('');
}

/**
 * Uppercase Latin, digits, '/' and '-' only.
 * Diacritics (e.g. š, é) are stripped via NFD decomposition + combining-mark removal after transliteration,
 * so Cyrillic digraphs (ѓ/ќ etc., which also canonically decompose under NFD) are mapped first and unaffected.
 */
export function normalizeRef(s: string): string {
  const flat = transliterate(s).normalize('NFD').replace(/\p{M}/gu, '');
  return flat.toUpperCase().replace(/[^A-Z0-9/-]/g, '');
}

/** Drops hyphens for loose invoice-number comparison: bank references often omit the separators present in the stored number. */
const withoutHyphens = (s: string) => s.replace(/-/g, '');

/**
 * Earliest occurrence of `needle` in `haystack` that isn't flanked by a digit on either side
 * (so a bare number like '0001' doesn't match inside '10001' or '300000000123456').
 * Returns -1 if there is no such occurrence.
 */
function findBoundedIndex(haystack: string, needle: string): number {
  if (!needle) return -1;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    const before = idx > 0 ? haystack[idx - 1] : undefined;
    const after = idx + needle.length < haystack.length ? haystack[idx + needle.length] : undefined;
    if ((before === undefined || !/\d/.test(before)) && (after === undefined || !/\d/.test(after))) return idx;
    idx = haystack.indexOf(needle, idx + 1);
  }
  return -1;
}

export interface MatchCandidate { invoiceId: string; number: string; contactLastName: string; outstandingMinor: number }
export type MatchResult = { invoiceId: string; confidence: 'exact' | 'likely' };

export function matchLine(line: ParsedStatementLine, candidates: MatchCandidate[]): MatchResult | null {
  if (line.amountMinor <= 0) return null;
  const text = normalizeRef(`${line.reference} ${line.counterparty}`);
  const looseText = withoutHyphens(text);
  const hits = candidates
    .map((c) => ({ c, idx: c.number ? findBoundedIndex(looseText, withoutHyphens(normalizeRef(c.number))) : -1 }))
    .filter((h) => h.idx !== -1);
  if (hits.length === 1) return { invoiceId: hits[0]!.c.invoiceId, confidence: 'exact' };
  if (hits.length > 1) {
    const byOutstanding = hits.filter((h) => h.c.outstandingMinor === line.amountMinor);
    if (byOutstanding.length === 1) return { invoiceId: byOutstanding[0]!.c.invoiceId, confidence: 'exact' };
    const earliest = hits.reduce((a, b) => (b.idx < a.idx ? b : a));
    return { invoiceId: earliest.c.invoiceId, confidence: 'likely' };
  }
  const byAmount = candidates.filter((c) => c.outstandingMinor === line.amountMinor);
  const withName = byAmount.filter((c) => { const n = normalizeRef(c.contactLastName); return n.length >= 3 && text.includes(n); });
  if (withName.length === 1) return { invoiceId: withName[0]!.invoiceId, confidence: 'likely' };
  // amount alone is not enough
  return null;
}

export function matchStatementLines(lines: ParsedStatementLine[], candidates: MatchCandidate[]) {
  const out: ({ index: number } & MatchResult)[] = [];
  lines.forEach((l, index) => { const m = matchLine(l, candidates); if (m) out.push({ index, ...m }); });
  return out;
}
