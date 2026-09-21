import { expect, test } from '@playwright/test';

const slug = `e2e-${Date.now().toString(36)}`;
const password = 'correct-horse-1';

test('register, create contact, building, unit, logout and login', async ({ page }) => {
  await page.goto('/register');
  await page.getByTestId('orgName').fill('Е2Е Фирма');
  await page.getByTestId('slug').fill(slug);
  await page.getByTestId('firstName').fill('Ева');
  await page.getByTestId('lastName').fill('Тест');
  await page.getByTestId('email').fill(`eva@${slug}.mk`);
  await page.getByTestId('password').fill(password);
  await page.getByRole('button', { name: /Отвори сметка|Create account/ }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByTestId('stat-buildings')).toHaveText('0');

  await page.getByTestId('nav-contacts').click();
  await page.getByTestId('add').click();
  await page.getByTestId('firstName').fill('Марко');
  await page.getByTestId('lastName').fill('Марков');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('row')).toHaveCount(1);

  await page.getByTestId('nav-buildings').click();
  await page.getByTestId('add').click();
  await page.getByTestId('name').fill('Партизанска 12');
  await page.getByTestId('address').fill('Партизанска 12');
  await page.getByTestId('city').fill('Скопје');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('row')).toHaveCount(1);
  await page.getByTestId('building-link').click();

  await page.getByTestId('add-unit').click();
  await page.getByTestId('label').fill('12');
  await page.getByTestId('floor').fill('3');
  await page.getByTestId('areaM2').fill('64.5');
  await page.getByTestId('ownerContactId').selectOption({ label: 'Марко Марков' });
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('row')).toHaveCount(1);
  await expect(page.getByTestId('row')).toContainText('Марко Марков');

  await page.getByTestId('logout').click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByTestId('tenantSlug').fill(slug);
  await page.getByTestId('email').fill(`eva@${slug}.mk`);
  await page.getByTestId('password').fill(password);
  await page.getByRole('button', { name: /Најави се|Log in/ }).click();
  await expect(page.getByTestId('stat-buildings')).toHaveText('1');
});
