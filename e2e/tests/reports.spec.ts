import { expect, test } from '@playwright/test';

const API = 'http://localhost:3001';
const slug = `e2e-izvestaj-${Date.now().toString(36)}`;
const password = 'correct-horse-1';
/** The tenant's civil day: what the handover form and the Art. 30 clock are both measured in. */
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Skopje', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const year = Number(today.slice(0, 4));

test('a manager issues the annual report and hands the building over with its data export', async ({ page }) => {
  await page.goto('/register');
  await page.getByTestId('orgName').fill('Е2Е Извештаи');
  await page.getByTestId('slug').fill(slug);
  await page.getByTestId('firstName').fill('Ива');
  await page.getByTestId('lastName').fill('Тест');
  await page.getByTestId('email').fill(`iva@${slug}.mk`);
  await page.getByTestId('password').fill(password);
  await page.getByRole('button', { name: /Отвори сметка|Create account/ }).click();
  await expect(page).toHaveURL(/\/app$/);

  // Seed through the API with the session cookie the registration just set.
  const post = async (path: string, data: unknown = {}) => {
    const res = await page.request.post(`${API}${path}`, { data });
    expect(res.status(), `${path} → ${await res.text()}`).toBeLessThan(300);
    return res.json();
  };
  const taxRates = await (await page.request.get(`${API}/api/tax-rates`)).json();
  const vatId = taxRates.rows.find((r: { rateBp: number }) => r.rateBp === 1800).id;
  const o1 = await post('/api/contacts', { firstName: 'Марко', lastName: 'Марков' });
  const o2 = await post('/api/contacts', { firstName: 'Ана', lastName: 'Анева' });
  const building = await post('/api/buildings', { name: 'Илинденска 3', address: 'Илинденска 3', city: 'Скопје', postalCode: '1000' });
  await post(`/api/buildings/${building.id}/units`, { label: '1', kind: 'apartment', areaM2: 50, ownerContactId: o1.id });
  await post(`/api/buildings/${building.id}/units`, { label: '2', kind: 'apartment', areaM2: 50, ownerContactId: o2.id });
  // 300,00 den per apartment plus 18 % VAT = 354,00 den per invoice, 708,00 den billed in all.
  const service = await post('/api/services', { name: 'Чистење', pricing: 'fixed_per_unit', defaultPriceMinor: 30000, taxRateId: vatId, appliesTo: ['apartment'] });
  await post(`/api/buildings/${building.id}/services`, { serviceId: service.id, startsPeriod: '2026-01' });
  const period = await post(`/api/buildings/${building.id}/periods`, { period: '2026-09' });
  await post(`/api/buildings/${building.id}/periods/${period.id}/generate`);
  await post(`/api/buildings/${building.id}/periods/${period.id}/publish`);

  const invoices = await (await page.request.get(`${API}/api/invoices?buildingId=${building.id}&pageSize=50`)).json();
  const markos = invoices.rows.find((i: { contactId: string }) => i.contactId === o1.id);
  expect(markos.totalMinor).toBe(35400);
  await post(`/api/invoices/${markos.id}/payments`, { amountMinor: markos.totalMinor, method: 'bank_transfer', paidAt: new Date().toISOString() });
  await post(`/api/buildings/${building.id}/reserve-fund/opening-balance`, { amountMinor: 3_500_000 });
  await post(`/api/buildings/${building.id}/reserve-fund/expenses`, {
    fund: 'reserve', description: 'Санација на кровот', supplierText: 'Кровови ДООЕЛ', amountMinor: 120_000, paidAt: new Date().toISOString(),
  });
  // The management contract that ends today is what starts the Art. 30 clock (spec §4).
  await post(`/api/buildings/${building.id}/contracts`, { kind: 'management', title: 'Договор за управување', startsOn: `${year}-01-01`, endsOn: today });

  // --- the Reports tab shows the year before anything is filed ---
  await page.goto(`/app/buildings/${building.id}?tab=reports`);
  await expect(page.getByTestId('report-kpi-billed')).toContainText('708,00');
  await expect(page.getByTestId('report-kpi-collected')).toContainText('354,00');
  await expect(page.getByTestId('report-kpi-debt')).toContainText('354,00');
  await expect(page.getByTestId('report-kpi-rate')).toContainText('50,00 %');
  await expect(page.getByTestId('row')).toHaveCount(0);

  // --- the annual report ---
  await page.getByTestId('report-issue-annual').click();
  await expect(page.getByTestId('row')).toHaveCount(1);
  await expect(page.getByTestId('row').first()).toContainText(`Годишен извештај ${year}`);
  const annualHref = (await page.getByTestId('report-download').first().getAttribute('href'))!;
  const annualPdf = await page.request.get(annualHref);
  expect(annualPdf.status()).toBe(200);
  expect((await annualPdf.body()).subarray(0, 4).toString()).toBe('%PDF');

  // Art. 31 turns green, and its deep link now points at the tab that fixed it.
  await page.goto(`/app/buildings/${building.id}?tab=compliance`);
  await expect(page.getByTestId('compliance-card-annual_report-status')).toHaveText('Во ред');
  await expect(page.getByTestId('compliance-card-handover-status')).toHaveText('Доспева');
  await expect(page.getByTestId('compliance-fix-annual_report')).toHaveAttribute('href', `/app/buildings/${building.id}?tab=reports`);
  await expect(page.getByTestId('compliance-fix-handover')).toHaveAttribute('href', `/app/buildings/${building.id}?tab=reports`);

  // --- the handover ---
  await page.getByTestId('compliance-fix-handover').click();
  await expect(page).toHaveURL(new RegExp(`\\?tab=reports$`));
  await page.getByTestId('handover-as-of').fill(today);
  await page.getByTestId('handover-bank-regular').fill('354,00');
  await page.getByTestId('handover-bank-reserve').fill('33.800,00');
  await page.getByTestId('handover-note').fill('Предадено на новиот управител.');
  await page.getByTestId('report-issue-handover').click();
  await expect(page.getByTestId('row')).toHaveCount(2);
  // The document title is "Извештај за примопредавање <asOf>" (lowercase after "за"); the brief's
  // capitalised 'Примопредавање' never appears verbatim in the UI (verified against
  // packages/domain/src/country/mk.ts `reports.handoverTitle`), so the substring check is
  // adjusted to the real casing.
  await expect(page.getByTestId('row').first()).toContainText('примопредавање');

  const zipHref = (await page.getByTestId('report-export').first().getAttribute('href'))!;
  const zip = await page.request.get(zipHref);
  expect(zip.status()).toBe(200);
  expect(zip.headers()['content-type']).toBe('application/zip');
  expect((await zip.body()).subarray(0, 2).toString()).toBe('PK');

  // Art. 30 stops, and both events are on the compliance screen as evidence.
  await page.goto(`/app/buildings/${building.id}?tab=compliance`);
  await expect(page.getByTestId('compliance-card-handover-status')).toHaveText('Во ред');
  await expect(page.getByTestId('compliance-event').first()).toContainText('Издаден извештај за примопредавање');
});
