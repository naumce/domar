import type { CountryPack } from './types.js';

function groupThousands(intPart: string, sep: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

export const mkPack: CountryPack = {
  code: 'mk',
  currency: 'MKD',
  locale: 'mk-MK',
  defaultTaxRates: [
    { name: 'Без ДДВ', rateBp: 0, isDefault: false },
    { name: 'ДДВ 5%', rateBp: 500, isDefault: false },
    { name: 'ДДВ 10%', rateBp: 1000, isDefault: false },
    { name: 'ДДВ 18%', rateBp: 1800, isDefault: true },
  ],
  invoiceLayout: {
    showBuildingWideAmountPerLine: true,
    showManagementFeeLine: true,
    showReserveFundContribution: true,
    showReserveFundBuildingBalance: true,
    showPreviousBalance: true,
  },
  reminderRules: {
    consecutiveUnpaid: 2,
    totalUnpaid: 3,
    feeAllowed: false,
    channels: ['email', 'sms', 'letter'],
  },
  formatMoney(minor: number): string {
    const sign = minor < 0 ? '-' : '';
    const abs = Math.abs(minor);
    const intPart = Math.floor(abs / 100).toString();
    const frac = (abs % 100).toString().padStart(2, '0');
    return `${sign}${groupThousands(intPart, '.')},${frac} ден.`;
  },
  parseAmountToMinor(text: string): number {
    const cleaned = text.replace(/\s/g, '').replace(/ден\.?/i, '');
    if (!/^-?[\d.,]+$/.test(cleaned)) throw new Error(`not an amount: ${text}`);
    const lastComma = cleaned.lastIndexOf(',');
    const lastDot = cleaned.lastIndexOf('.');
    let normalized: string;
    if (lastComma > lastDot) {
      normalized = cleaned.replace(/\./g, '').replace(',', '.');
    } else if (lastDot > lastComma) {
      const decimals = cleaned.length - lastDot - 1;
      normalized = decimals === 3 && lastComma === -1 ? cleaned.replace(/\./g, '') : cleaned.replace(/,/g, '');
    } else {
      normalized = cleaned;
    }
    const value = Number(normalized);
    if (!Number.isFinite(value)) throw new Error(`not an amount: ${text}`);
    return Math.round(value * 100);
  },
};
