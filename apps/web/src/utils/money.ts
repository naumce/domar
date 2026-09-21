export function formatMoney(minor: number, currency = 'MKD'): string {
  if (currency !== 'MKD') return new Intl.NumberFormat('mk-MK', { style: 'currency', currency }).format(minor / 100);
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const int = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}${int},${String(abs % 100).padStart(2, '0')} ден.`;
}

/** "1.234,56" | "1234.56" | 300 → minor units; empty/garbage → null */
export function toMinor(input: string | number): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input * 100) : null;
  const s = input.replace(/\s/g, '');
  if (!/^-?[\d.,]+$/.test(s)) return null;
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  let normalized: string;
  if (lastComma > lastDot) normalized = s.replace(/\./g, '').replace(',', '.');
  else if (lastDot > lastComma) normalized = s.replace(/,/g, '');
  else normalized = s;
  const n = Number(normalized);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export function percentFromBp(bp: number): string {
  return `${(bp / 100).toFixed(2).replace('.', ',')} %`;
}
