import { expect, test } from '@playwright/test';

const API = 'http://localhost:3001';
const slug = `e2e-comp-${Date.now().toString(36)}`;
const password = 'correct-horse-1';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1');

test('a manager fixes the fund accounts, files a document and distributes an extraordinary cost', async ({ page }) => {
  await page.goto('/register');
  await page.getByTestId('orgName').fill('Е2Е Усогласеност');
  await page.getByTestId('slug').fill(slug);
  await page.getByTestId('firstName').fill('Ана');
  await page.getByTestId('lastName').fill('Тест');
  await page.getByTestId('email').fill(`ana@${slug}.mk`);
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
  const building = await post('/api/buildings', { name: 'Јане Сандански 5', address: 'Јане Сандански 5', city: 'Скопје', postalCode: '1000' });
  await post(`/api/buildings/${building.id}/units`, { label: '1', kind: 'apartment', areaM2: 50, ownerContactId: o1.id });
  await post(`/api/buildings/${building.id}/units`, { label: '2', kind: 'apartment', areaM2: 50, ownerContactId: o2.id });
  const service = await post('/api/services', { name: 'Чистење', pricing: 'fixed_per_unit', defaultPriceMinor: 30000, taxRateId: vatId, appliesTo: ['apartment'] });
  await post(`/api/buildings/${building.id}/services`, { serviceId: service.id, startsPeriod: '2026-01' });
  const period = await post(`/api/buildings/${building.id}/periods`, { period: '2026-09' });
  await post(`/api/buildings/${building.id}/periods/${period.id}/generate`);
  await post(`/api/buildings/${building.id}/periods/${period.id}/publish`);

  // The compliance tab is the building's landing tab, and the empty accounts are the first breach.
  await page.goto(`/app/buildings/${building.id}`);
  await expect(page.getByTestId('compliance-card-fund_accounts-status')).toHaveText('Задоцнето');
  await expect(page.getByTestId('compliance-card-invoices-status')).toHaveText('Во ред');
  await expect(page.getByTestId('compliance-status')).toHaveText('Задоцнето');

  // Filling both account numbers turns Art. 42/45 green without leaving the screen.
  await page.getByTestId('fund-accounts-regular').fill('210-0000000000-19');
  await page.getByTestId('fund-accounts-reserve').fill('210-0000000000-96');
  await page.getByTestId('fund-accounts-save').click();
  await expect(page.getByTestId('fund-accounts-saved')).toBeVisible();
  await expect(page.getByTestId('compliance-card-fund_accounts-status')).toHaveText('Во ред');

  // A document is filed against the building.
  await page.goto(`/app/buildings/${building.id}?tab=documents`);
  await page.getByTestId('doc-kind').selectOption('minutes');
  await page.getByTestId('doc-title').fill('Записник од собир');
  await page.getByTestId('doc-file').setInputFiles({ name: 'zapisnik.pdf', mimeType: 'application/pdf', buffer: PDF });
  await page.getByTestId('doc-upload').click();
  await expect(page.getByTestId('row')).toHaveCount(1);
  await expect(page.getByTestId('doc-download')).toBeVisible();
  const download = await page.request.get((await page.getByTestId('doc-download').getAttribute('href'))!);
  expect(download.status()).toBe(200);
  expect((await download.body()).subarray(0, 4).toString()).toBe('%PDF');

  // An extraordinary cost goes out as real invoices, split equally over the two apartments.
  await page.goto(`/app/buildings/${building.id}?tab=extraordinary`);
  await page.getByTestId('extra-description').fill('Санација на кров');
  await page.getByTestId('extra-amount').fill('6.000,00');
  await page.getByTestId('extra-fund').selectOption('reserve');
  await page.getByTestId('extra-distribution').selectOption('equal');
  await page.getByTestId('extra-due-days').fill('30');
  await page.getByTestId('extra-submit').click();
  // The exact sentence, not a bare '2': that also matches the period the same line prints.
  await expect(page.getByTestId('extra-result')).toContainText('Создадени се 2 пресметки');
  await expect(page.getByTestId('extra-history-row')).toHaveCount(1);

  const periods = await (await page.request.get(`${API}/api/buildings/${building.id}/periods`)).json();
  const extra = periods.rows.find((p: { kind: string }) => p.kind === 'extraordinary');
  expect(extra).toBeTruthy();
  expect(extra.status).toBe('published');
  const invoices = await (await page.request.get(`${API}/api/invoices?buildingId=${building.id}&pageSize=50`)).json();
  const extraInvoices = invoices.rows.filter((i: { periodId: string }) => i.periodId === extra.id);
  expect(extraInvoices).toHaveLength(2);
  expect(extraInvoices.map((i: { totalMinor: number }) => i.totalMinor)).toEqual([300000, 300000]);
  expect(extraInvoices.every((i: { status: string }) => i.status === 'published')).toBe(true);

  // The compliance screen shows the event the distribution wrote.
  await page.goto(`/app/buildings/${building.id}?tab=compliance`);
  await expect(page.getByTestId('compliance-card-extraordinary_costs')).toContainText('1');
  await expect(page.getByTestId('compliance-event').first()).toContainText('Распределен вонреден трошок');

  // And the portfolio page lists the building with its worst status.
  await page.getByTestId('nav-compliance').click();
  await expect(page).toHaveURL(/\/app\/compliance$/);
  await expect(page.getByTestId('compliance-row')).toHaveCount(1);
  await expect(page.getByTestId('compliance-row-status')).toHaveText('Доспева'); // fund transparency is still due
});
