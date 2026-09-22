import type { ParsedStatementLine } from './types.js';

const CYR: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', ѓ: 'gj', е: 'e', ж: 'z', з: 'z', ѕ: 'dz', и: 'i', ј: 'j', к: 'k', л: 'l', љ: 'lj', м: 'm', н: 'n', њ: 'nj', о: 'o', п: 'p', р: 'r', с: 's', т: 't', ќ: 'kj', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'c', џ: 'dz', ш: 's' };

export function transliterate(s: string): string {
  return [...s.toLowerCase()].map((c) => CYR[c] ?? c).join('');
}

/** Uppercase Latin, digits, '/' and '-' only. */
export function normalizeRef(s: string): string {
  return transliterate(s).toUpperCase().replace(/[^A-Z0-9/-]/g, '');
}

/** Drops hyphens for loose invoice-number comparison: bank references often omit the separators present in the stored number. */
const withoutHyphens = (s: string) => s.replace(/-/g, '');

export interface MatchCandidate { invoiceId: string; number: string; contactLastName: string; outstandingMinor: number }
export type MatchResult = { invoiceId: string; confidence: 'exact' | 'likely' };

export function matchLine(line: ParsedStatementLine, candidates: MatchCandidate[]): MatchResult | null {
  if (line.amountMinor <= 0) return null;
  const text = normalizeRef(`${line.reference} ${line.counterparty}`);
  const looseText = withoutHyphens(text);
  const exact = candidates.find((c) => c.number && looseText.includes(withoutHyphens(normalizeRef(c.number))));
  if (exact) return { invoiceId: exact.invoiceId, confidence: 'exact' };
  const byAmount = candidates.filter((c) => c.outstandingMinor === line.amountMinor);
  const withName = byAmount.filter((c) => { const n = normalizeRef(c.contactLastName); return n.length >= 3 && text.includes(n); });
  if (withName.length === 1) return { invoiceId: withName[0]!.invoiceId, confidence: 'likely' };
  if (byAmount.length === 1 && withName.length === 0) return null; // amount alone is not enough
  return null;
}

export function matchStatementLines(lines: ParsedStatementLine[], candidates: MatchCandidate[]) {
  const out: ({ index: number } & MatchResult)[] = [];
  lines.forEach((l, index) => { const m = matchLine(l, candidates); if (m) out.push({ index, ...m }); });
  return out;
}
