import { mkPack } from '@domar/domain';

export function formatMoney(minor: number, currency = 'MKD'): string {
  if (currency !== 'MKD') return new Intl.NumberFormat('mk-MK', { style: 'currency', currency }).format(minor / 100);
  return mkPack.formatMoney(minor);
}

/** "1.234,56" | "1234.56" → minor units; empty/garbage → null */
export function toMinor(input: string): number | null {
  try {
    return mkPack.parseAmountToMinor(input);
  } catch {
    return null;
  }
}

export function percentFromBp(bp: number): string {
  return `${(bp / 100).toFixed(2).replace('.', ',')} %`;
}

/**
 * Plain quantity (m², shares) in the mk format: 54.5 → "54,5", 1234.5 → "1.234,5"; null → "—".
 * Hand-rolled like `formatMoney`: Chrome ships no `mk-MK` ICU data, so `Intl` silently falls back to en-US.
 */
export function formatNumber(value: number | null | undefined, maxFractionDigits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const [int, frac = ''] = Math.abs(value).toFixed(maxFractionDigits).split('.');
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const trimmed = frac.replace(/0+$/, '');
  return `${value < 0 ? '-' : ''}${grouped}${trimmed ? `,${trimmed}` : ''}`;
}

/**
 * "25.09.2026 11:04" — hand-rolled like `formatMoney`: Chrome ships no `mk-MK` ICU data, so
 * `toLocaleDateString('mk-MK')` silently falls back to en-US formatting.
 */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
