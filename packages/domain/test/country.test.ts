import { describe, expect, it } from 'vitest';
import { getCountryPack, mkPack } from '../src/country/index.js';

describe('mk country pack', () => {
  it('is returned by getCountryPack', () => {
    expect(getCountryPack('mk')).toBe(mkPack);
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
});
