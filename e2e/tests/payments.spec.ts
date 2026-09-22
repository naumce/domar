import { expect, test } from '@playwright/test';

const slug = `e2e-pay-${Date.now().toString(36)}`;

test('record a payment and match a CSV statement', async ({ page, request }) => {
  await page.goto('/register');
  await page.getByTestId('orgName').fill('Е2Е Наплата 2');
  await page.getByTestId('slug').fill(slug);
  await page.getByTestId('firstName').fill('Ева'); await page.getByTestId('lastName').fill('Тест');
  await page.getByTestId('email').fill(`eva@${slug}.mk`); await page.getByTestId('password').fill('correct-horse-1');
  await page.getByRole('button', { name: /Отвори сметка|Create account/ }).click();
  await expect(page).toHaveURL(/\/app$/);
  const cookie = async () => (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  const api = async (method: 'POST' | 'PUT' | 'GET', url: string, data?: unknown) => {
    const res = await request.fetch(`http://localhost:3001${url}`, { method, data, headers: { cookie: await cookie() } });
    expect(res.ok(), `${method} ${url} → ${res.status()} ${await res.text()}`).toBeTruthy();
    return res.json();
  };
  // building with two owners, one service, published period (all via API for speed)
  const o1 = await api('POST', '/api/contacts', { firstName: 'Марко', lastName: 'Марков' });
  const o2 = await api('POST', '/api/contacts', { firstName: 'Ана', lastName: 'Бошковска' });
  const b = await api('POST', '/api/buildings', { name: 'Е2Е Наплата', address: 'Улица 2', city: 'Скопје' });
  await api('POST', `/api/buildings/${b.id}/units`, { label: '1', kind: 'apartment', areaM2: 50, ownerContactId: o1.id });
  await api('POST', `/api/buildings/${b.id}/units`, { label: '2', kind: 'apartment', areaM2: 50, ownerContactId: o2.id });
  const rates = await api('GET', '/api/tax-rates');
  const vat = rates.rows.find((r: { rateBp: number }) => r.rateBp === 1800).id;
  const svc = await api('POST', '/api/services', { name: 'Чистење', pricing: 'fixed_per_unit', defaultPriceMinor: 100000, taxRateId: vat, appliesTo: ['apartment'] });
  await api('POST', `/api/buildings/${b.id}/services`, { serviceId: svc.id, startsPeriod: '2026-01' });
  const period = await api('POST', `/api/buildings/${b.id}/periods`, { period: '2026-09' });
  await api('POST', `/api/buildings/${b.id}/periods/${period.id}/generate`);
  await api('POST', `/api/buildings/${b.id}/periods/${period.id}/publish`);
  const invoices = await api('GET', `/api/invoices?buildingId=${b.id}`);
  const inv1 = invoices.rows.find((i: { contactId: string }) => i.contactId === o1.id); // 1000 + 18% = 1180,00
  const inv2 = invoices.rows.find((i: { contactId: string }) => i.contactId === o2.id);

  // record a cash payment through the UI
  await page.goto(`/app/invoices/${inv1.id}`);
  await expect(page.getByTestId('invoice-outstanding')).toHaveText('1.180,00 ден.');
  await page.getByTestId('record-payment').click();
  await page.getByTestId('pay-method').selectOption('cash');
  await page.getByTestId('pay-submit').click();
  await expect(page.getByTestId('invoice-outstanding')).toHaveText('0,00 ден.');
  await expect(page.getByTestId('invoice-paid')).toHaveText('1.180,00 ден.');

  // import a CSV statement that pays the second invoice by number
  const csv = `date;amount;reference;counterparty\n2026-10-05;1.180,00;Uplata ${inv2.number};Ana Boskovska\n`;
  await page.goto(`/app/buildings/${b.id}?tab=statements`);
  await page.getByTestId('stmt-file').setInputFiles({ name: 'izvod.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
  await page.getByTestId('stmt-upload').click();
  await expect(page.getByTestId('stmt-row').first()).toContainText('izvod.csv');
  await expect(page.getByTestId('row').first()).toContainText(/Усогласено|Matched/);
  await page.goto(`/app/invoices/${inv2.id}`);
  await expect(page.getByTestId('invoice-outstanding')).toHaveText('0,00 ден.');

  // payments page shows both
  await page.getByTestId('nav-payments').click();
  await expect(page.getByTestId('row')).toHaveCount(2);
  await expect(page.getByTestId('sum-received')).toHaveText('2.360,00 ден.');
  // dashboard
  await page.getByTestId('nav-dashboard').click();
  await expect(page.getByTestId('stat-unpaid')).toHaveText('0');
});
