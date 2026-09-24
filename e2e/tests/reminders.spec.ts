import { expect, test } from '@playwright/test';

const API = 'http://localhost:3001';
const slug = `e2e-rem-${Date.now().toString(36)}`;
const password = 'correct-horse-1';
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

test('two overdue periods produce an emailed reminder with a PDF letter', async ({ page }) => {
  await page.goto('/register');
  await page.getByTestId('orgName').fill('Е2Е Опомени');
  await page.getByTestId('slug').fill(slug);
  await page.getByTestId('firstName').fill('Ева');
  await page.getByTestId('lastName').fill('Тест');
  await page.getByTestId('email').fill(`eva@${slug}.mk`);
  await page.getByTestId('password').fill(password);
  await page.getByRole('button', { name: /Отвори сметка|Create account/ }).click();
  await expect(page).toHaveURL(/\/app$/);

  // Seed through the API with the session cookie the registration just set; page.request shares the
  // browser context's cookie jar. Due dates in the past are only reachable through publish's dueAt.
  const post = async (path: string, data: unknown = {}) => {
    const res = await page.request.post(`${API}${path}`, { data });
    expect(res.status(), `${path} → ${await res.text()}`).toBeLessThan(300);
    return res.json();
  };
  const taxRates = await (await page.request.get(`${API}/api/tax-rates`)).json();
  const vatId = taxRates.rows.find((r: { rateBp: number }) => r.rateBp === 1800).id;
  const owner = await post('/api/contacts', { firstName: 'Марко', lastName: 'Марков', email: `marko@${slug}.mk` });
  const building = await post('/api/buildings', { name: 'Партизанска 12', address: 'Партизанска 12', city: 'Скопје', postalCode: '1000' });
  await post(`/api/buildings/${building.id}/units`, { label: '1', kind: 'apartment', areaM2: 50, ownerContactId: owner.id });
  const service = await post('/api/services', { name: 'Чистење', pricing: 'fixed_per_unit', defaultPriceMinor: 30000, taxRateId: vatId, appliesTo: ['apartment'] });
  await post(`/api/buildings/${building.id}/services`, { serviceId: service.id, startsPeriod: '2026-01' });
  for (const [period, days] of [['2026-07', 75], ['2026-08', 45]] as const) {
    const p = await post(`/api/buildings/${building.id}/periods`, { period });
    await post(`/api/buildings/${building.id}/periods/${p.id}/generate`);
    await post(`/api/buildings/${building.id}/periods/${p.id}/publish`, { dueAt: daysAgo(days) });
  }

  // Run the evaluation from the UI.
  await page.goto(`/app/buildings/${building.id}?tab=reminders`);
  await page.getByTestId('reminders-run').click();
  await expect(page.getByTestId('reminders-created')).toHaveText('Изготвени опомени: 1');
  await expect(page.getByTestId('reminder-reason')).toHaveText('Две последователни неплатени');
  await expect(page.getByTestId('reminder-status')).toHaveText('Испратена');

  // The letter renders as a real PDF.
  const href = await page.getByTestId('reminder-pdf').getAttribute('href');
  expect(href).toContain('/api/reminders/');
  const pdf = await page.request.get(href!);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toContain('application/pdf');
  expect((await pdf.body()).subarray(0, 4).toString()).toBe('%PDF');

  // Running again inside 30 days creates nothing.
  await page.getByTestId('reminders-run').click();
  await expect(page.getByTestId('reminders-created')).toHaveText('Нема нови опомени.');
  await expect(page.getByTestId('row')).toHaveCount(1);

  // And one invoice can be emailed from its own page.
  const invoices = await (await page.request.get(`${API}/api/invoices?buildingId=${building.id}&pageSize=50`)).json();
  await page.goto(`/app/invoices/${invoices.rows[0].id}`);
  await page.getByTestId('send-email').click();
  await expect(page.getByTestId('send-email-status')).toHaveText('Испратено');
});
