import { describe, expect, it } from 'vitest';
import { getCountryPack, mkPack } from '../src/country/index.js';
import { MAINTENANCE_CATEGORIES } from '../src/maintenance/status.js';

describe('mk country pack', () => {
  it('is returned by getCountryPack', () => {
    expect(getCountryPack('mk')).toBe(mkPack);
  });
  it('getCountryPack is case-insensitive, and throws by name on a code with no pack', () => {
    // A database column is a plain varchar with no enum behind it (`buildings.country_code`,
    // `tenants.country_code`), so a differently-cased value reaching here is routine, not exotic —
    // it must resolve to the same pack, never to `undefined` for a caller to dereference.
    expect(getCountryPack('MK')).toBe(mkPack);
    expect(getCountryPack('Mk')).toBe(mkPack);
    expect(() => getCountryPack('xx')).toThrow(/unknown country pack: xx/);
  });
  it('has MKD currency and mk-MK locale', () => {
    expect(mkPack.currency).toBe('MKD');
    expect(mkPack.locale).toBe('mk-MK');
  });
  it('ships default VAT rates with 18% as default', () => {
    const def = mkPack.defaultTaxRates.find((r) => r.isDefault);
    expect(def).toEqual({ name: 'ДДВ 18%', rateBp: 1800, isDefault: true });
    expect(mkPack.defaultTaxRates.map((r) => r.rateBp).sort((a, b) => a - b)).toEqual([0, 500, 1000, 1800]);
  });
  it('encodes Art. 28 reminder thresholds', () => {
    expect(mkPack.reminderRules).toEqual({
      consecutiveUnpaid: 2,
      totalUnpaid: 3,
      feeAllowed: false,
      channels: ['email', 'sms', 'letter'],
    });
  });
  it('carries the labels the billing engine synthesizes lines with', () => {
    expect(mkPack.labels).toEqual({
      reserveFund: 'Резервен фонд', managementFee: 'Управувачки услуги',
      payment: 'Уплата', paymentVoid: 'Сторно уплата', openingBalance: 'Почетно салдо',
      reminderIntro: 'Според нашата евиденција, следните месечни пресметки за управување и одржување на заедничките делови на зградата не се платени во целост.',
      reminderLegal: 'Оваа опомена е издадена согласно член 28 од Законот за домување. За опомената не се наплатува надоместок. Ве молиме долгот да го платите во најкраток можен рок на сметката наведена подолу.',
      assemblyInvitationIntro: 'Ве покануваме на собир на сопствениците на посебните делови од станбената зграда, со следниот дневен ред:',
      assemblyLegal: 'Поканата е доставена согласно член 37 од Законот за домување, најмалку 15 дена пред денот на одржувањето. Собирот полноважно одлучува ако присуствуваат сопственици кои претставуваат повеќе од половина од вкупните гласови, а одлуката е усвоена ако за неа гласале повеќе гласови отколку против неа.',
      reports: {
        annualTitle: 'Годишен извештај',
        annualLegal: 'Овој годишен извештај за управувањето и одржувањето на заедничките делови на станбената зграда е изготвен согласно член 31 од Законот за домување и им се доставува на сопствениците на посебните делови.',
        handoverTitle: 'Извештај за примопредавање',
        handoverLegal: 'Овој извештај, заедно со целосната документација и податоците за зградата, се предава согласно член 30 од Законот за домување, во рок од 8 дена од престанокот на договорот за управување.',
        noSupplier: 'Без добавувач',
      },
      maintenanceExpense: 'Одржување',
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
    });
  });
  it('encodes Art. 33 invoice layout requirements', () => {
    expect(mkPack.invoiceLayout).toEqual({
      showBuildingWideAmountPerLine: true,
      showManagementFeeLine: true,
      showReserveFundContribution: true,
      showReserveFundBuildingBalance: true,
      showPreviousBalance: true,
    });
  });
  it('formats money as denars with two decimals', () => {
    expect(mkPack.formatMoney(123456789)).toBe('1.234.567,89 ден.');
    expect(mkPack.formatMoney(-50)).toBe('-0,50 ден.');
    expect(mkPack.formatMoney(0)).toBe('0,00 ден.');
  });
  it('parses localized amounts to minor units', () => {
    // Original test cases
    expect(mkPack.parseAmountToMinor('1.234,56')).toBe(123456);
    expect(mkPack.parseAmountToMinor('1234.56')).toBe(123456);
    expect(mkPack.parseAmountToMinor('1 234,5')).toBe(123450);
    expect(mkPack.parseAmountToMinor('-12')).toBe(-1200);
    expect(() => mkPack.parseAmountToMinor('abc')).toThrow();
    // Fix round 1 test cases (correct grouping vs. decimal detection)
    expect(mkPack.parseAmountToMinor('0.285')).toBe(29);
    expect(mkPack.parseAmountToMinor('12.345')).toBe(1234500);
    expect(mkPack.parseAmountToMinor('1.234')).toBe(123400);
    expect(mkPack.parseAmountToMinor('1.23')).toBe(123);
    expect(mkPack.parseAmountToMinor('1,234.56')).toBe(123456);
    expect(mkPack.parseAmountToMinor('-1.234,56')).toBe(-123456);
    expect(mkPack.parseAmountToMinor('1.234.567,89')).toBe(123456789);
    expect(mkPack.parseAmountToMinor('1,5')).toBe(150);
    expect(mkPack.parseAmountToMinor('12,345')).toBe(1235);
    expect(mkPack.parseAmountToMinor('1234')).toBe(123400);
    // Should throw on invalid grouping
    expect(() => mkPack.parseAmountToMinor('1.2.345')).toThrow();
    expect(() => mkPack.parseAmountToMinor('1.23.4')).toThrow();
    expect(() => mkPack.parseAmountToMinor('1,234,5')).toThrow();
    expect(() => mkPack.parseAmountToMinor('1.234.56')).toThrow();
    expect(() => mkPack.parseAmountToMinor('.5')).toThrow();
    expect(() => mkPack.parseAmountToMinor('')).toThrow();
  });

  it('the pack labels exactly the categories the database enum holds, in order', () => {
    expect(mkPack.maintenanceCategories.map((c) => c.key)).toEqual(MAINTENANCE_CATEGORIES);
    expect(new Set(mkPack.maintenanceCategories.map((c) => c.label)).size).toBe(MAINTENANCE_CATEGORIES.length);
    for (const c of mkPack.maintenanceCategories) expect(c.label.trim().length, c.key).toBeGreaterThan(0);
    expect(mkPack.labels.maintenanceExpense).toBe('Одржување');
  });
});
