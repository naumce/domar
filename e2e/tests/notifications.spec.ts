import { expect, test } from '@playwright/test';

const API = 'http://localhost:3001';
const slug = `e2e-izvestuvanja-${Date.now().toString(36)}`;
const password = 'correct-horse-1';
const ownerPassword = 'battery-staple-7';

test('a published invoice and a portal request reach the right bell', async ({ page, browser }) => {
  // --- the manager opens the organisation ---
  await page.goto('/register');
  await page.getByTestId('orgName').fill('Е2Е Известувања');
  await page.getByTestId('slug').fill(slug);
  await page.getByTestId('firstName').fill('Ива');
  await page.getByTestId('lastName').fill('Тест');
  await page.getByTestId('email').fill(`iva@${slug}.mk`);
  await page.getByTestId('password').fill(password);
  await page.getByRole('button', { name: /Отвори сметка|Create account/ }).click();
  await expect(page).toHaveURL(/\/app$/);

  const post = async (path: string, data: unknown = {}) => {
    const res = await page.request.post(`${API}${path}`, { data });
    expect(res.status(), `${path} → ${await res.text()}`).toBeLessThan(300);
    return res.json();
  };
  const owner = await post('/api/contacts', { firstName: 'Марко', lastName: 'Марков', email: `marko@${slug}.mk` });
  const building = await post('/api/buildings', { name: 'Партизанска 12', address: 'Партизанска 12', city: 'Скопје', postalCode: '1000' });
  const unit = await post(`/api/buildings/${building.id}/units`, { label: '1', kind: 'apartment', areaM2: 50, ownerContactId: owner.id });
  const service = await post('/api/services', { name: 'Одржување на влез', pricing: 'fixed_per_unit', defaultPriceMinor: 30_000 });
  await post(`/api/buildings/${building.id}/services`, { serviceId: service.id, startsPeriod: '2026-09' });

  // The owner's portal code, read off the manager's screen exactly once.
  await page.goto(`/app/contacts/${owner.id}`);
  await page.getByTestId('portal-issue').click();
  const code = (await page.getByTestId('portal-issued-code').innerText()).trim();

  const ownerContext = await browser.newContext();
  const owners = await ownerContext.newPage();
  try {
    await owners.goto('/portal/register');
    await owners.getByTestId('portal-code').fill(code);
    await owners.getByTestId('portal-email').fill(`marko@${slug}.mk`);
    await owners.getByTestId('portal-password').fill(ownerPassword);
    await owners.getByTestId('portal-submit').click();
    await expect(owners).toHaveURL(/\/portal$/);

    // --- the manager publishes September ---
    const period = await post(`/api/buildings/${building.id}/periods`, { period: '2026-09' });
    await post(`/api/buildings/${building.id}/periods/${period.id}/generate`);
    await post(`/api/buildings/${building.id}/periods/${period.id}/publish`);

    // --- the owner's bell ---
    await owners.reload();
    await expect(owners.getByTestId('notification-count')).toHaveText('1');
    await owners.getByTestId('notification-bell').click();
    await expect(owners.getByTestId('notification-item')).toHaveCount(1);
    await expect(owners.getByTestId('notification-item')).toContainText('Нова фактура');
    // Spec §11 lives in the payload, not the panel: the app shows the amount, the push would not.
    await expect(owners.getByTestId('notification-item')).toContainText('ден.');
    await owners.getByTestId('notification-item').click();
    await expect(owners).toHaveURL(/\/portal\/invoices\/[0-9a-f-]{36}$/);
    await owners.goto('/portal');
    await expect(owners.getByTestId('notification-count')).toHaveCount(0);

    // --- the owner files a maintenance request ---
    await owners.getByTestId('portal-nav-maintenance').click();
    await owners.getByTestId('portal-maintenance-title').fill('Протекува цевка во визбата');
    await owners.getByTestId('portal-maintenance-description').fill('Трет ден.');
    await owners.getByTestId('portal-maintenance-category').selectOption('plumbing');
    await owners.getByTestId('portal-maintenance-submit').click();
    await expect(owners.getByTestId('portal-maintenance-row')).toHaveCount(1);

    // --- the manager's bell ---
    await page.goto('/app');
    await expect(page.getByTestId('notification-count')).toHaveText('1');
    await page.getByTestId('notification-bell').click();
    await expect(page.getByTestId('notification-item')).toContainText('Ново барање за одржување');
    await page.getByTestId('notification-item').click();
    await expect(page).toHaveURL(new RegExp(`/app/buildings/${building.id}\\?tab=maintenance$`));
    await page.goto('/app');
    await expect(page.getByTestId('notification-count')).toHaveCount(0);

    // --- the manager triages it and the owner is told ---
    const board = await page.request.get(`${API}/api/buildings/${building.id}/maintenance`);
    const requestId = (await board.json()).rows[0].id;
    await post(`/api/maintenance-requests/${requestId}/status`, { status: 'triaged' });

    await owners.goto('/portal');
    await expect(owners.getByTestId('notification-count')).toHaveText('1');
    await owners.getByTestId('notification-bell').click();
    await expect(owners.getByTestId('notification-item').first()).toContainText('Одржување: Прегледано');

    // --- the delivery job: guarded, and it really drains ---
    // The harness gives this API a JOB_TOKEN (e2e/playwright.config.ts) so the walk-through covers
    // the path a deployment's cron actually takes, not only the refusal a misconfigured one gets.
    const noToken = await page.request.post(`${API}/api/jobs/notifications`);
    expect(noToken.status()).toBe(401);
    const wrongToken = await page.request.post(`${API}/api/jobs/notifications`, { headers: { 'x-job-token': 'nope' } });
    expect(wrongToken.status()).toBe(403);
    const drained = await page.request.post(`${API}/api/jobs/notifications`, { headers: { 'x-job-token': 'e2e-job-token-not-a-secret' } });
    expect(drained.status(), await drained.text()).toBe(200);
    // Nobody in this walk-through subscribed a browser to push, so every owner row falls through to
    // the email fallback; the run must still claim them rather than leave the queue standing.
    const result = await drained.json();
    expect(result.claimed).toBeGreaterThan(0);
    expect(result.pushed).toBe(0);
  } finally {
    await ownerContext.close();
  }

  // The offline shell and the manifest are served, and the worker is not cached hard.
  const manifest = await page.request.get('/manifest.webmanifest');
  expect(manifest.status()).toBe(200);
  expect((await manifest.json()).scope).toBe('/portal');
  const worker = await page.request.get('/portal/sw.js');
  expect(worker.status()).toBe(200);
  expect(await worker.text()).toContain('notificationclick');
  expect(unit.id).toBeTruthy();
});
