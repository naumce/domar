import { expect, test } from '@playwright/test';

const slug = `e2e-bill-${Date.now().toString(36)}`;
const password = 'correct-horse-1';

test('bill a building end to end', async ({ page, request }) => {
  await page.goto('/register');
  await page.getByTestId('orgName').fill('Е2Е Наплата');
  await page.getByTestId('slug').fill(slug);
  await page.getByTestId('firstName').fill('Ева');
  await page.getByTestId('lastName').fill('Тест');
  await page.getByTestId('email').fill(`eva@${slug}.mk`);
  await page.getByTestId('password').fill(password);
  await page.getByRole('button', { name: /Отвори сметка|Create account/ }).click();
  await expect(page).toHaveURL(/\/app$/);

  // owner + building + two units through the UI already covered by smoke; use the API through the browser session for speed
  const api = async (method: 'POST' | 'PUT', url: string, data: unknown) => {
    const cookies = await page.context().cookies();
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const res = await request.fetch(`http://localhost:3001${url}`, { method, data, headers: { cookie } });
    expect(res.ok(), `${method} ${url} → ${res.status()} ${await res.text()}`).toBeTruthy();
    return res.json();
  };
  const owner = await api('POST', '/api/contacts', { firstName: 'Марко', lastName: 'Марков' });
  const building = await api('POST', '/api/buildings', { name: 'Е2Е Зграда', address: 'Улица 1', city: 'Скопје' });
  await api('POST', `/api/buildings/${building.id}/units`, { label: '1', kind: 'apartment', areaM2: 50, ownerContactId: owner.id });
  await api('POST', `/api/buildings/${building.id}/units`, { label: '2', kind: 'apartment', areaM2: 70, ownerContactId: owner.id });

  // service through the UI
  await page.getByTestId('nav-services').click();
  await expect(page).toHaveURL(/\/app\/services$/); // the previous page's `add` must be gone before we click
  await page.getByTestId('add').click();
  await page.getByTestId('service-name').fill('Чистење');
  await page.getByTestId('service-price').fill('300');
  await page.getByTestId('kind-apartment').check();
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('row')).toHaveCount(1);

  // attach + reserve fund + period through the building tabs
  await page.goto(`/app/buildings/${building.id}?tab=services`);
  await page.getByTestId('attach-service').click();
  await page.getByTestId('attach-service-select').selectOption({ index: 1 });
  await page.getByTestId('attach-submit').click();
  await expect(page.getByTestId('row')).toHaveCount(1);

  await page.getByTestId('tab-reserve-fund').click();
  await page.getByTestId('rf-basis').selectOption('per_m2');
  await page.getByTestId('rf-amount').fill('10');
  await page.getByTestId('rf-active').check();
  await page.getByTestId('rf-kind-apartment').check();
  await page.getByTestId('rf-save').click();
  await page.getByTestId('rf-opening').fill('35000');
  await page.getByTestId('rf-opening-submit').click();
  await expect(page.getByTestId('rf-balance')).toHaveText('35.000,00 ден.');

  await page.getByTestId('tab-periods').click();
  await page.getByTestId('period-month').fill('2026-09');
  await page.getByTestId('period-fee').fill('150');
  await page.getByTestId('period-create').click();
  await page.getByTestId('period-link').first().click();
  await expect(page.getByTestId('period-status')).toHaveText(/Отворен|Open/);

  await page.getByTestId('generate').click();
  await expect(page.getByTestId('period-status')).toHaveText(/Нацрти|Drafts/);
  await expect(page.getByTestId('invoice-link')).toHaveCount(1); // one owner → one invoice
  page.once('dialog', (d) => d.accept());
  await page.getByTestId('publish').click();
  await expect(page.getByTestId('period-status')).toHaveText(/Објавен|Published/);
  await page.getByTestId('invoice-link').first().click();
  await expect(page.getByTestId('invoice-number')).toHaveText('INV-0001/2026');
  // cleaning 300×2 = 600 net + 18% = 708; reserve 10×(50+70) = 1200; fee 150×2 = 300 + 18% = 354 → total 2262,00
  await expect(page.getByTestId('invoice-total')).toHaveText('2.262,00 ден.');
  const html = page.getByTestId('open-html');
  const href = await html.getAttribute('href');
  const res = await request.get(href!, { headers: { cookie: (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ') } });
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain('INV-0001/2026');
});
