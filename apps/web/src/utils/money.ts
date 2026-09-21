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
