import { divRoundHalfUp } from '../money.js';
import { csvParser } from '../statements/csv.js';
import { mt940Parser } from '../statements/mt940.js';
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
    payment: 'Уплата',
    paymentVoid: 'Сторно уплата',
    openingBalance: 'Почетно салдо',
    reminderIntro: 'Според нашата евиденција, следните месечни пресметки за управување и одржување на заедничките делови на зградата не се платени во целост.',
    reminderLegal: 'Оваа опомена е издадена согласно член 28 од Законот за домување. За опомената не се наплатува надоместок. Ве молиме долгот да го платите во најкраток можен рок на сметката наведена подолу.',
    assemblyInvitationIntro: 'Ве покануваме на собир на сопствениците на посебните делови од станбената зграда, со следниот дневен ред:',
    assemblyLegal: 'Поканата е доставена согласно член 37 од Законот за домување, најмалку 15 дена пред денот на одржувањето. Собирот полноважно одлучува ако присуствуваат сопственици кои претставуваат повеќе од половина од вкупните гласови, а одлуката е усвоена ако за неа гласале повеќе гласови отколку против неа.',
    compliance: {
      invoices: { title: 'Месечни пресметки', hint: 'Објавете ја пресметката за тековниот месец за сите сопственици.' },
      reminders: { title: 'Опомени за должници', hint: 'Изгответе опомени за сопствениците што го поминале прагот од член 28.' },
      assembly: { title: 'Собир на сопственици', hint: 'Свикајте собир најмалку 15 дена однапред и запишете записник.' },
      annual_report: { title: 'Годишен извештај', hint: 'Изгответе годишен извештај за управувањето и доставете го до сопствениците.' },
      fund_transparency: { title: 'Увид во состојбата на фондот', hint: 'Издадете код за порталот на барем еден сопственик за да има увид во фондот.' },
      fund_accounts: { title: 'Одвоени сметки за фондовите', hint: 'Внесете ги броевите на сметките на редовниот и на резервниот фонд.' },
      handover: { title: 'Примопредавање по истек на договор', hint: 'Во рок од 8 дена по истекот на договорот предајте извештај и целосна документација.' },
      extraordinary_costs: { title: 'Вонредни трошоци', hint: 'Распределените вонредни трошоци по член 47(5) се евидентираат тука.' },
    },
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
  complianceRules: {
    invoiceMaxAgeDays: 35,
    reminderGraceDays: 30,
    assemblyMaxAgeMonths: 12,
    assemblyInvitationMinDays: 15,
    annualReportMaxAgeMonths: 12,
    handoverDays: 8,
    graceDays: 30,
    graceMonths: 3,
  },
  statementParsers: [mt940Parser, csvParser],
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
