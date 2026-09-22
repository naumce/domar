import { describe, expect, it } from 'vitest';
import { mkPack } from '@domar/domain';
import { renderInvoiceHtml } from '../src/pdf/invoice-html.js';

const invoice = {
  id: 'inv1', tenantId: 't', periodId: 'p1', buildingId: 'b1', contactId: 'c1', number: 'INV-0001/2026', status: 'published' as const, currency: 'MKD', unitIds: ['A', 'P1'],
  subtotalMinor: 224660, taxMinor: 31439, totalMinor: 256099, previousBalanceMinor: 5000, amountDueMinor: 261099, reserveFundBuildingBalanceMinor: 3500000,
  issuedAt: new Date('2026-10-01T08:00:00Z'), dueAt: new Date('2026-10-16T08:00:00Z'), publishedAt: new Date('2026-10-01T08:00:00Z'), createdAt: new Date(), updatedAt: new Date(), period: '2026-09',
  paidMinor: 0, outstandingMinor: 256099, payments: [],
  contact: { id: 'c1', kind: 'person' as const, firstName: 'Тест', lastName: 'Анѓеловски', email: null, address: 'Партизанска 12/1', companyNumber: null, vatNumber: null, phone: null, notes: null, tenantId: 't', createdAt: new Date(), updatedAt: new Date() },
  building: { id: 'b1', name: 'Партизанска 12', address: 'Партизанска 12', city: 'Скопје', postalCode: '1000', regularFundAccount: '200001234567890', reserveFundAccount: '200009876543210', countryCode: 'mk', representativeContactId: null, shareBasis: 'area' as const, tenantId: 't', createdAt: new Date(), updatedAt: new Date() },
  lines: [
    { id: 'l1', kind: 'service' as const, description: 'Чистење', fund: 'regular' as const, unitId: 'A', unitLabel: '1', buildingWideNetMinor: 90000, ownerNetMinor: 30000, taxRateBp: 1800, ownerTaxMinor: 5400, ownerGrossMinor: 35400, sortOrder: 0, tenantId: 't', invoiceId: 'inv1', periodLineId: null },
    { id: 'l2', kind: 'management_fee' as const, description: 'Управувачки услуги', fund: 'regular' as const, unitId: 'A', unitLabel: '1', buildingWideNetMinor: 45000, ownerNetMinor: 15000, taxRateBp: 1800, ownerTaxMinor: 2700, ownerGrossMinor: 17700, sortOrder: 1, tenantId: 't', invoiceId: 'inv1', periodLineId: null },
    { id: 'l3', kind: 'reserve_fund' as const, description: 'Резервен фонд', fund: 'reserve' as const, unitId: 'A', unitLabel: '1', buildingWideNetMinor: 225000, ownerNetMinor: 50000, taxRateBp: 0, ownerTaxMinor: 0, ownerGrossMinor: 50000, sortOrder: 2, tenantId: 't', invoiceId: 'inv1', periodLineId: null },
  ],
};
const tenant = { name: 'Тест Фирма ДООЕЛ', companyNumber: '1234567', vatNumber: 'MK4030001234567', address: 'ул. 1 бр. 1, Скопје', phone: '+389 2 000 000', email: 'info@firma.mk', bankName: 'Комерцијална банка', bankAccount: '300000000000000' };

describe('renderInvoiceHtml', () => {
  const html = renderInvoiceHtml({ invoice, tenant, formatMoney: mkPack.formatMoney, locale: 'mk' });
  it('contains header, parties and number', () => {
    for (const s of ['INV-0001/2026', 'Тест Фирма ДООЕЛ', 'MK4030001234567', 'Тест Анѓеловски', 'Партизанска 12/1', '2026-09', 'Партизанска 12']) expect(html).toContain(s);
  });
  it('shows every line with building-wide and owner amounts (Art. 33)', () => {
    expect(html).toContain('Чистење');
    expect(html).toContain('900,00 ден.');   // building-wide net of cleaning
    expect(html).toContain('300,00 ден.');   // owner net
    expect(html).toContain('354,00 ден.');   // owner gross
    expect(html).toContain('Управувачки услуги');
    expect(html).toContain('Резервен фонд');
    expect(html).toContain('2.250,00 ден.'); // reserve fund building-wide
  });
  it('shows totals, previous balance, amount due and the reserve fund building balance', () => {
    for (const s of ['2.246,60 ден.', '314,39 ден.', '2.560,99 ден.', '50,00 ден.', '2.610,99 ден.', '35.000,00 ден.']) expect(html).toContain(s);
  });
  it('shows payment details with the invoice number as reference', () => {
    expect(html).toContain('Комерцијална банка');
    expect(html).toContain('200001234567890');
    expect(html).toMatch(/Цел на дознака[\s\S]{0,80}INV-0001\/2026/);
  });
  it('labels drafts and escapes HTML in user data', () => {
    const draft = renderInvoiceHtml({ invoice: { ...invoice, number: null, status: 'draft', contact: { ...invoice.contact, lastName: '<b>X</b>' } }, tenant, formatMoney: mkPack.formatMoney, locale: 'mk' });
    expect(draft).toContain('НАЦРТ');
    expect(draft).not.toContain('<b>X</b>');
    expect(draft).toContain('&lt;b&gt;X&lt;/b&gt;');
  });
});
