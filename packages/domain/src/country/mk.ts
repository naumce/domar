import { divRoundHalfUp } from '../money.js';
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
  labels: {
    reserveFund: 'Резервен фонд',
    managementFee: 'Управувачки услуги',
  },
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
    // Step 1: Clean input
    const cleaned = text.replace(/\s/g, '').replace(/ден\.?/i, '');
    if (!/^-?\d[\d.,]*$/.test(cleaned)) throw new Error(`not an amount: ${text}`);

    // Step 2: Extract sign
    const negative = cleaned.startsWith('-');
    const body = negative ? cleaned.slice(1) : cleaned;

    // Step 3: Count separators
    const commas = (body.match(/,/g) || []).length;
    const dots = (body.match(/\./g) || []).length;
    const lastCommaIdx = body.lastIndexOf(',');
    const lastDotIdx = body.lastIndexOf('.');
    const lastSepIndex = Math.max(lastCommaIdx, lastDotIdx);
    const lastSep = lastSepIndex === -1 ? undefined : body[lastSepIndex];

    // Step 4: Determine decimal separator
    let dec: ',' | '.' | null = null;
    if (lastSep !== undefined && (lastSep === ',' || lastSep === '.')) {
      const count = lastSep === ',' ? commas : dots;
      const after = body.slice(lastSepIndex + 1);
      const before = body.slice(0, lastSepIndex);
      const intDigitsBefore = before.replace(/[.,]/g, '');

      if (
        count === 1 &&
        (lastSep === ',' || after.length !== 3 || intDigitsBefore === '0' || intDigitsBefore.length > 3)
      ) {
        dec = lastSep;
      }
    }

    // Step 5: Split into integer and fractional parts
    let intPart: string;
    let frac: string;
    if (dec) {
      const decIdx = dec === ',' ? lastCommaIdx : lastDotIdx;
      intPart = body.slice(0, decIdx);
      frac = body.slice(decIdx + 1);
      if (!frac) throw new Error(`not an amount: ${text}`);
    } else {
      intPart = body;
      frac = '';
    }

    // Step 6: Validate and extract integer digits
    let intDigits: string;
    if (intPart.includes(',') || intPart.includes('.')) {
      // Has grouping
      const groupSep = intPart.includes(',') ? ',' : '.';
      if (intPart.includes(',') && intPart.includes('.')) throw new Error(`not an amount: ${text}`);

      const groups = intPart.split(groupSep);
      if (groups.length > 1) {
        const firstGroup = groups[0];
        if (!firstGroup || firstGroup.length < 1 || firstGroup.length > 3) throw new Error(`not an amount: ${text}`);
        for (let i = 1; i < groups.length; i++) {
          const group = groups[i];
          if (!group || group.length !== 3) throw new Error(`not an amount: ${text}`);
        }
      }
      intDigits = groups.join('');
    } else {
      intDigits = intPart;
    }

    // Step 7: Compute minor units
    const intMinor = Number(intDigits) * 100;
    let fracMinor = 0;
    if (frac.length > 0) {
      if (frac.length <= 2) {
        fracMinor = Number(frac.padEnd(2, '0'));
      } else {
        fracMinor = divRoundHalfUp(Number(frac), 10 ** (frac.length - 2));
      }
    }

    return (negative ? -1 : 1) * (intMinor + fracMinor);
  },
};
