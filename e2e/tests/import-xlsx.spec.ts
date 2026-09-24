import { expect, test } from '@playwright/test';
// A default import, not a namespace one: Playwright runs this on Node, `xlsx` has no exports map, so
// Node loads its CJS build and only the interop default carries `utils` (design addendum 2b).
import XLSX from 'xlsx';

const slug = `e2e-xlsx-${Date.now().toString(36)}`;
const password = 'correct-horse-1';

// Column names no alias table knows, except "Кат" and "Презиме" — those must arrive prefilled.
const AOA = [
  ['Стан', 'Кат', 'Намена', 'Квадратура', 'Сопственик', 'Презиме'],
  ['1', '1', 'стан', '54,5', 'Марко', 'Марков'],
  ['2', '1', 'стан', '62', 'Ана', 'Бошковска'],
  ['P-1', '', 'паркинг', '', '', ''],
];

function workbook(): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(AOA), 'Единици');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

test('import units from an xlsx by mapping its columns', async ({ page }) => {
  await page.goto('/register');
  await page.getByTestId('orgName').fill('Е2Е Табела');
  await page.getByTestId('slug').fill(slug);
  await page.getByTestId('firstName').fill('Ева');
  await page.getByTestId('lastName').fill('Тест');
  await page.getByTestId('email').fill(`eva@${slug}.mk`);
  await page.getByTestId('password').fill(password);
  await page.getByRole('button', { name: /Отвори сметка|Create account/ }).click();
  await expect(page).toHaveURL(/\/app$/);

  await page.getByTestId('nav-buildings').click();
  await expect(page).toHaveURL(/\/app\/buildings$/);
  await page.getByTestId('add').click();
  await page.getByTestId('name').fill('Јане Сандански 5');
  await page.getByTestId('address').fill('Јане Сандански 5');
  await page.getByTestId('city').fill('Скопје');
  await page.getByTestId('submit').click();
  await page.getByTestId('building-link').click();

  await page.getByTestId('tab-import').click();
  await page.getByTestId('import-file').setInputFiles({
    name: 'единици.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: workbook(),
  });

  // The mapping step opens by itself and has already recognised what it can.
  await expect(page.getByTestId('import-map-floor')).toHaveValue('1');
  await expect(page.getByTestId('import-map-ownerLastName')).toHaveValue('5');
  await expect(page.getByTestId('import-unmapped')).toContainText('Стан');

  await page.getByTestId('import-map-label').selectOption('0');
  await page.getByTestId('import-map-kind').selectOption('2');
  await page.getByTestId('import-map-areaM2').selectOption('3');
  await page.getByTestId('import-map-ownerFirstName').selectOption('4');
  await page.getByTestId('import-map-apply').click();
  await expect(page.getByTestId('import-map-ready')).toBeVisible();

  await page.getByTestId('import-preview').click();
  await expect(page.getByTestId('import-count-units')).toHaveText('3');
  await expect(page.getByTestId('import-count-contacts')).toHaveText('2 / 0');
  await page.getByTestId('import-commit').click();
  await expect(page.getByTestId('import-done')).toBeVisible();

  await page.getByTestId('tab-units').click();
  await expect(page.getByTestId('row')).toHaveCount(3);
  await expect(page.getByText('54,5').first()).toBeVisible();

  // The mapping is remembered, so the same file needs no second pass over the selects.
  await page.getByTestId('tab-import').click();
  await page.getByTestId('import-file').setInputFiles({
    name: 'единици.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: workbook(),
  });
  await expect(page.getByTestId('import-map-label')).toHaveValue('0');
  await expect(page.getByTestId('import-map-kind')).toHaveValue('2');
});
