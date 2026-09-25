import { expect, test } from '@playwright/test';

const API = 'http://localhost:3001';
const slug = `e2e-odrzuvanje-${Date.now().toString(36)}`;
const password = 'correct-horse-1';
const ownerPassword = 'battery-staple-7';
/** A 1×1 PNG: the photo routes accept png and jpeg and nothing else. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('an owner reports a leak, a technician fixes it and the manager closes it with a cost', async ({ page, browser }) => {
  // --- the manager opens the organisation ---
  await page.goto('/register');
  await page.getByTestId('orgName').fill('Е2Е Одржување');
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
  await post(`/api/buildings/${building.id}/units`, { label: '1', kind: 'apartment', areaM2: 50, ownerContactId: owner.id });
  await post('/api/suppliers', { name: 'Водовод Инженеринг ДООЕЛ' });
  // 35.000,00 den in the reserve fund: enough to pay for the repair and leave a readable remainder.
  await post(`/api/buildings/${building.id}/reserve-fund/opening-balance`, { amountMinor: 3_500_000 });
  // The technician who will do the work, signed in later in their own browser context.
  const technician = await post('/api/users', { email: `stefan@${slug}.mk`, firstName: 'Стефан', lastName: 'Стефановски', role: 'technician' });

  // The owner's portal code, read off the manager's screen exactly once.
  await page.goto(`/app/contacts/${owner.id}`);
  await page.getByTestId('portal-issue').click();
  const code = (await page.getByTestId('portal-issued-code').innerText()).trim();

  // --- the owner reports the leak, with a photo ---
  const ownerContext = await browser.newContext();
  const owners = await ownerContext.newPage();
  try {
    await owners.goto('/portal/register');
    await owners.getByTestId('portal-code').fill(code);
    await owners.getByTestId('portal-email').fill(`marko@${slug}.mk`);
    await owners.getByTestId('portal-password').fill(ownerPassword);
    await owners.getByTestId('portal-submit').click();
    await expect(owners).toHaveURL(/\/portal$/);

    await owners.getByTestId('portal-nav-maintenance').click();
    await owners.getByTestId('portal-maintenance-title').fill('Протекува цевка во визбата');
    await owners.getByTestId('portal-maintenance-description').fill('Вода тече покрај вертикалата под влезот, веќе трет ден.');
    await owners.getByTestId('portal-maintenance-category').selectOption('plumbing');
    await owners.getByTestId('portal-maintenance-priority').selectOption('high');
    await owners.getByTestId('portal-maintenance-file').setInputFiles({ name: 'voda.png', mimeType: 'image/png', buffer: PNG });
    await owners.getByTestId('portal-maintenance-submit').click();
    await expect(owners.getByTestId('portal-maintenance-row')).toHaveCount(1);
    await expect(owners.getByTestId('portal-maintenance-status')).toHaveText('Ново');

    // --- the manager triages and assigns ---
    await page.goto(`/app/buildings/${building.id}?tab=maintenance`);
    await expect(page.getByTestId('maintenance-count-new')).toHaveText('1');
    await expect(page.getByTestId('maintenance-card')).toContainText('Протекува цевка во визбата');
    await page.getByTestId('maintenance-card').click();
    await expect(page.getByTestId('maintenance-panel-status')).toHaveText('Ново');
    // The owner's photo is already on the manager's panel.
    await expect(page.getByTestId('maintenance-photo')).toHaveCount(1);
    await page.getByTestId('maintenance-triage').click();
    await expect(page.getByTestId('maintenance-panel-status')).toHaveText('Примено');
    await page.getByTestId('maintenance-assignee').selectOption(technician.user.id);
    await page.getByTestId('maintenance-assign').click();
    await expect(page.getByTestId('maintenance-panel-status')).toHaveText('Доделено');
    await expect(page.getByTestId('maintenance-count-assigned')).toHaveText('1');
    const requestUrl = page.url();

    // --- the technician signs in and starts the job ---
    const techContext = await browser.newContext();
    try {
      const tech = await techContext.newPage();
      await tech.goto('/login');
      await tech.getByTestId('tenantSlug').fill(slug);
      await tech.getByTestId('email').fill(`stefan@${slug}.mk`);
      await tech.getByTestId('password').fill(technician.temporaryPassword);
      await tech.getByRole('button', { name: /Најави се|Sign in/ }).click();
      await expect(tech).toHaveURL(/\/app$/);

      await tech.goto(requestUrl);
      // A technician sees their own queue and no create form at all.
      await expect(tech.getByTestId('maintenance-card')).toHaveCount(1);
      await expect(tech.getByTestId('maintenance-create')).toHaveCount(0);
      await tech.getByTestId('maintenance-card').click();
      await expect(tech.getByTestId('maintenance-panel-status')).toHaveText('Доделено');
      await expect(tech.getByTestId('maintenance-close-open')).toHaveCount(0); // never books money
      await tech.getByTestId('maintenance-start').click();
      await expect(tech.getByTestId('maintenance-panel-status')).toHaveText('Во тек');
      await tech.getByTestId('maintenance-note').fill('Заменета спојка, фатено во 40 минути.');
      await tech.getByTestId('maintenance-note-add').click();
      // created, photo_added, triaged, assigned, in_progress, comment — six, in that order.
      await expect(tech.getByTestId('maintenance-event')).toHaveCount(6);
    } finally {
      await techContext.close();
    }

    // --- the manager closes it with a 12.000 den cost on the reserve fund ---
    await page.reload();
    await page.getByTestId('maintenance-card').click();
    await expect(page.getByTestId('maintenance-panel-status')).toHaveText('Во тек');
    await page.getByTestId('maintenance-close-open').click();
    await page.getByTestId('maintenance-close-fund').selectOption('reserve');
    await page.getByTestId('maintenance-close-amount').fill('12.000,00');
    await page.getByTestId('maintenance-close-supplier').selectOption({ label: 'Водовод Инженеринг ДООЕЛ' });
    await page.getByTestId('maintenance-close-note').fill('Заменета спојка, дефектот е отстранет.');
    await page.getByTestId('maintenance-close-submit').click();
    await expect(page.getByTestId('maintenance-panel-status')).toHaveText('Завршено');
    await expect(page.getByTestId('maintenance-panel-cost')).toContainText('12.000,00');
    await expect(page.getByTestId('maintenance-count-done')).toHaveText('1');

    // --- the money is in the fund, through the ordinary expense flow ---
    await page.goto(`/app/buildings/${building.id}?tab=reserve-fund`);
    await expect(page.getByText('Одржување: Водовод и канализација — Протекува цевка во визбата').first()).toBeVisible();
    const state = await (await page.request.get(`${API}/api/buildings/${building.id}/reserve-fund`)).json();
    expect(state.balanceMinor).toBe(3_500_000 - 1_200_000);
    const tx = await (await page.request.get(`${API}/api/buildings/${building.id}/reserve-fund/transactions`)).json();
    expect(tx.rows[0]).toMatchObject({ kind: 'expense', fund: 'reserve', amountMinor: -1_200_000 });

    // --- the owner sees the closed request and the manager's note ---
    await owners.reload();
    await expect(owners.getByTestId('portal-maintenance-status')).toHaveText('Завршено');
    await owners.getByTestId('portal-maintenance-link').click();
    await expect(owners.getByTestId('portal-maintenance-status')).toHaveText('Завршено');
    await expect(owners.locator('body')).toContainText('Заменета спојка, дефектот е отстранет.');
    // The technician's internal note is not theirs to read.
    await expect(owners.locator('body')).not.toContainText('фатено во 40 минути');
    await expect(owners.getByTestId('portal-maintenance-photo')).toHaveCount(1);
    // Closed means closed: the portal offers no way to write to it any more.
    await expect(owners.getByTestId('portal-maintenance-send')).toHaveCount(0);

    // …and the money is visible where Art. 45(4) puts it.
    await owners.getByTestId('portal-nav-fund').click();
    await expect(owners.getByTestId('portal-fund-reserve')).toHaveText('23.000,00 ден.');
  } finally {
    await ownerContext.close();
  }
});
