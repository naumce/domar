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
    expect(mkPack.parseAmountToMinor('1.234,56')).toBe(123456);
    expect(mkPack.parseAmountToMinor('1234.56')).toBe(123456);
    expect(mkPack.parseAmountToMinor('1 234,5')).toBe(123450);
    expect(mkPack.parseAmountToMinor('-12')).toBe(-1200);
    expect(() => mkPack.parseAmountToMinor('abc')).toThrow();
  });
});
