import { expect, test } from '@playwright/test';

const API = 'http://localhost:3001';
const slug = `e2e-portal-${Date.now().toString(36)}`;
const password = 'correct-horse-1';
const ownerPassword = 'battery-staple-7';

test('a manager issues a code and the owner reads their invoice in the portal', async ({ page, browser }) => {
  // --- manager ---
  await page.goto('/register');
  await page.getByTestId('orgName').fill('Е2Е Портал');
  await page.getByTestId('slug').fill(slug);
  await page.getByTestId('firstName').fill('Ева');
  await page.getByTestId('lastName').fill('Тест');
  await page.getByTestId('email').fill(`eva@${slug}.mk`);
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
  const owner = await post('/api/contacts', { firstName: 'Марко', lastName: 'Марков', email: `marko@${slug}.mk` });
  const building = await post('/api/buildings', { name: 'Партизанска 12', address: 'Партизанска 12', city: 'Скопје', postalCode: '1000' });
  await post(`/api/buildings/${building.id}/units`, { label: '1', kind: 'apartment', areaM2: 50, ownerContactId: owner.id });
  const service = await post('/api/services', { name: 'Чистење', pricing: 'fixed_per_unit', defaultPriceMinor: 30000, taxRateId: vatId, appliesTo: ['apartment'] });
  await post(`/api/buildings/${building.id}/services`, { serviceId: service.id, startsPeriod: '2026-01' });
  const put = await page.request.put(`${API}/api/buildings/${building.id}/reserve-fund`, { data: { basis: 'per_m2', amountMinor: 1000, appliesTo: ['apartment'], active: true } });
  expect(put.status()).toBeLessThan(300);
  await post(`/api/buildings/${building.id}/reserve-fund/opening-balance`, { amountMinor: 3500000 });
  const period = await post(`/api/buildings/${building.id}/periods`, { period: '2026-09' });
  await post(`/api/buildings/${building.id}/periods/${period.id}/generate`);
  await post(`/api/buildings/${building.id}/periods/${period.id}/publish`);

  // Issue the code from the manager UI and read it off the screen (it is shown exactly once).
  await page.goto(`/app/contacts/${owner.id}`);
  await expect(page.getByTestId('portal-status')).toHaveText('Нема пристап');
  await page.getByTestId('portal-issue').click();
  const code = (await page.getByTestId('portal-issued-code').innerText()).trim();
  expect(code).toMatch(/^[A-HJ-NP-Za-km-z2-9]{8}$/);
  await expect(page.getByTestId('portal-status')).toHaveText('Испратен код');

  // --- owner, in a second browser context with its own cookie jar ---
  const ownerContext = await browser.newContext();
  try {
    const owners = await ownerContext.newPage();
    await owners.goto('/portal/register');
    await owners.getByTestId('portal-code').fill(code);
    await owners.getByTestId('portal-email').fill(`marko@${slug}.mk`);
    await owners.getByTestId('portal-password').fill(ownerPassword);
    await owners.getByTestId('portal-submit').click();
    await expect(owners).toHaveURL(/\/portal$/);

    await expect(owners.getByTestId('portal-card-buildings')).toHaveText('Партизанска 12');
    await expect(owners.getByTestId('portal-card-unpaid')).toHaveText('1');

    // Чистење 300,00 + 18% ДДВ 54,00 + резервен фонд 50 m² × 10,00 = 500,00 → 854,00 ден.
    await owners.getByTestId('portal-nav-invoices').click();
    await expect(owners.getByTestId('portal-invoice-outstanding')).toHaveText('854,00 ден.');
    await owners.getByTestId('portal-invoice-link').click();
    await expect(owners.getByTestId('portal-invoice-total')).toHaveText('854,00 ден.');

    const href = await owners.getByTestId('portal-invoice-pdf').getAttribute('href');
    expect(href).toContain('/api/portal/invoices/');
    expect(href).toContain(`contactId=${owner.id}`);
    const pdf = await owners.request.get(href!);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-type']).toContain('application/pdf');
    expect((await pdf.body()).subarray(0, 4).toString()).toBe('%PDF');

    await owners.getByTestId('portal-nav-fund').click();
    await expect(owners.getByTestId('portal-fund-reserve')).toHaveText('35.000,00 ден.');
    await expect(owners.getByTestId('portal-fund-billed-reserve')).toHaveText('500,00 ден.');

    await owners.getByTestId('portal-logout').click();
    await expect(owners).toHaveURL(/\/portal\/login$/);
    // The session is really gone: the guard bounces a direct visit back to the login page.
    await owners.goto('/portal');
    await expect(owners).toHaveURL(/\/portal\/login$/);
  } finally {
    await ownerContext.close();
  }

  // The manager's own session never reaches the portal API.
  const asManager = await page.request.get(`${API}/api/portal/me`);
  expect(asManager.status()).toBe(401);
});
