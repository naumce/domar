import { expect, test } from '@playwright/test';

const slug = `e2e-pilot-${Date.now().toString(36)}`;
const password = 'correct-horse-1';
const CSV = [
  'број;кат;тип;површина;удел;име;презиме;е-пошта;телефон;почетно салдо',
  `1;1;стан;54,5;0,085;Марко;Марков;marko@${slug}.mk;070111222;1.200,00`,
  `2;1;стан;62;0,095;Ана;Бошковска;ana@${slug}.mk;;0`,
  'P-1;;паркинг;;;;;;;',
  '',
].join('\n');

test('import units from CSV, read the owner balance and add a staff user', async ({ page }) => {
  await page.goto('/register');
  await page.getByTestId('orgName').fill('Е2Е Пилот');
  await page.getByTestId('slug').fill(slug);
  await page.getByTestId('firstName').fill('Ева');
  await page.getByTestId('lastName').fill('Тест');
  await page.getByTestId('email').fill(`eva@${slug}.mk`);
  await page.getByTestId('password').fill(password);
  await page.getByRole('button', { name: /Отвори сметка|Create account/ }).click();
  await expect(page).toHaveURL(/\/app$/);

  await page.getByTestId('nav-buildings').click();
  await page.getByTestId('add').click();
  await page.getByTestId('name').fill('Партизанска 12');
  await page.getByTestId('address').fill('Партизанска 12');
  await page.getByTestId('city').fill('Скопје');
  await page.getByTestId('submit').click();
  await page.getByTestId('building-link').click();

  // import: preview, then commit
  await page.getByTestId('tab-import').click();
  await page.getByTestId('import-file').setInputFiles({ name: 'units.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV, 'utf8') });
  await page.getByTestId('import-preview').click();
  await expect(page.getByTestId('import-count-units')).toHaveText('3');
  await expect(page.getByTestId('import-count-balances')).toHaveText('1');
  await page.getByTestId('import-commit').click();
  await expect(page.getByTestId('import-done')).toBeVisible();

  await page.getByTestId('tab-units').click();
  await expect(page.getByTestId('row')).toHaveCount(3);

  // the opening balance is on the owner's ledger
  await page.getByTestId('tab-opening-balances').click();
  await expect(page.getByText('1.200,00 ден.').first()).toBeVisible();
  await page.getByTestId('nav-contacts').click();
  await page.getByRole('link', { name: 'Марков' }).click();
  await expect(page.getByTestId('owner-balance')).toHaveText('1.200,00 ден.');

  // staff user with a one-time temporary password
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('users-add').click();
  await page.getByTestId('user-email').fill(`sara@${slug}.mk`);
  await page.getByTestId('user-firstName').fill('Сара');
  await page.getByTestId('user-lastName').fill('Стојанова');
  await page.getByTestId('user-role').selectOption('accountant');
  await page.getByTestId('user-submit').click();
  const temporaryPassword = (await page.getByTestId('temp-password').innerText()).trim();
  expect(temporaryPassword).toMatch(/^[A-HJ-NP-Za-km-z2-9]{16}$/);

  await page.getByTestId('logout').click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByTestId('tenantSlug').fill(slug);
  await page.getByTestId('email').fill(`sara@${slug}.mk`);
  await page.getByTestId('password').fill(temporaryPassword);
  await page.getByRole('button', { name: /Најави се|Log in/ }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByTestId('stat-buildings')).toHaveText('1');
});
