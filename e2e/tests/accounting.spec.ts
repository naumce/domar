import { expect, test } from '@playwright/test';

const API = 'http://localhost:3001';
const slug = `e2e-acct-${Date.now().toString(36)}`;
const password = 'correct-horse-1';

// The suite's clock reads 2026-09-26 or later. `2026-08` has genuinely ended by then and stays
// ended forever after, unlike "this month", which `close` would refuse today and any test run
// would refuse again on the first of its own month — so this is a fixed date, not `new Date()`.
// Every date here is derived from today, never written down: a walk-through pinned to a calendar
// year starts failing on its own, which is worse than no walk-through. The window runs from the
// start of last month to the start of the month after next, so it always contains the charge that
// books at publish time and always stays far inside the 366-day limit.
const pad = (n: number) => String(n).padStart(2, '0');
const monthStart = (offset: number): string => {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-01`;
};
const FROM = monthStart(-1);
const TO = monthStart(2);
/** Last month: ended, so `close` accepts it. */
const CLOSED_PERIOD = FROM.slice(0, 7);
const THIS_PERIOD = monthStart(0).slice(0, 7);

test('a manager maps the chart, sees a balanced trial balance, exports the zip and closes the month', async ({ page }) => {
  await page.goto('/register');
  await page.getByTestId('orgName').fill('Е2Е Сметководство');
  await page.getByTestId('slug').fill(slug);
  await page.getByTestId('firstName').fill('Ана');
  await page.getByTestId('lastName').fill('Тест');
  await page.getByTestId('email').fill(`ana@${slug}.mk`);
  await page.getByTestId('password').fill(password);
  await page.getByRole('button', { name: /Отвори сметка|Create account/ }).click();
  await expect(page).toHaveURL(/\/app$/);

  const post = async (path: string, data: unknown = {}) => {
    const res = await page.request.post(`${API}${path}`, { data });
    expect(res.status(), `${path} → ${await res.text()}`).toBeLessThan(300);
    return res.json();
  };
  const taxRates = await (await page.request.get(`${API}/api/tax-rates`)).json();
  const vatId = taxRates.rows.find((r: { rateBp: number }) => r.rateBp === 1800).id;
  const owner = await post('/api/contacts', { firstName: 'Марко', lastName: 'Марков' });
  const building = await post('/api/buildings', { name: 'Вардарска 9', address: 'Вардарска 9', city: 'Скопје', postalCode: '1000' });
  await post(`/api/buildings/${building.id}/units`, { label: '1', kind: 'apartment', areaM2: 50, ownerContactId: owner.id });
  const service = await post('/api/services', { name: 'Чистење', pricing: 'fixed_per_unit', defaultPriceMinor: 100000, taxRateId: vatId, appliesTo: ['apartment'] });
  await post(`/api/buildings/${building.id}/services`, { serviceId: service.id, startsPeriod: CLOSED_PERIOD });
  const period = await post(`/api/buildings/${building.id}/periods`, { period: THIS_PERIOD });
  await post(`/api/buildings/${building.id}/periods/${period.id}/generate`);
  await post(`/api/buildings/${building.id}/periods/${period.id}/publish`);
  const invoices = await (await page.request.get(`${API}/api/invoices?buildingId=${building.id}`)).json();
  // The invoice's own charge posting books at publish time (whatever "now" is when this runs); the
  // payment is pinned to match rather than left at `new Date()`, so the trial-balance totals below
  // reflect exactly these two postings and nothing the calendar could add or drop.
  await post(`/api/invoices/${invoices.rows[0].id}/payments`, { amountMinor: 118000, method: 'bank_transfer', paidAt: new Date().toISOString() });

  // An unmapped chart is called out by name, and nothing can be exported yet.
  await page.goto('/app/accounting');
  await expect(page.getByTestId('accounting-missing')).toContainText('Побарувања од сопственици');
  await expect(page.getByTestId('accounting-missing')).toContainText('ДДВ на излез');

  const slots: [string, string, string][] = [
    ['owner_receivable', '1200', 'Побарувања'], ['revenue_service', '7400', 'Приходи од услуги'],
    ['revenue_management_fee', '7410', 'Приходи од управување'], ['revenue_reserve_fund', '7420', 'Резервен фонд'],
    ['vat_output', '4700', 'ДДВ на излез'], ['cash_regular', '1000', 'Редовна сметка'],
    ['cash_reserve', '1001', 'Резервна сметка'], ['expense_default', '4000', 'Трошоци'], ['opening_balance', '9000', 'Почетна состојба'],
  ];
  for (const [slot, code, name] of slots) {
    await page.getByTestId(`account-code-${slot}-code`).fill(code);
    await page.getByTestId(`account-code-${slot}-name`).fill(name);
    await page.getByTestId(`account-code-${slot}-save`).click();
  }
  await expect(page.getByTestId('accounting-complete')).toBeVisible();

  // The window the manager hands the accountant, wide enough that today's postings are inside it.
  await page.getByTestId('accounting-from').fill(FROM);
  await page.getByTestId('accounting-to').fill(TO);
  await page.getByTestId('accounting-preview').click();
  await expect(page.getByTestId('accounting-balanced')).toBeVisible();
  // Balanced *and* non-zero: the charge (1200 dr/7400+4700 cr, 118000) and its payment (1000 dr/1200
  // cr, 118000) both land in the window, so debit = credit = 236000 — a real total, not 0 = 0.
  await expect(page.getByTestId('accounting-total-debit')).toHaveText('2.360,00 ден.');
  await expect(page.getByTestId('accounting-total-credit')).toHaveText('2.360,00 ден.');
  await expect(page.getByTestId('trial-row')).toHaveCount(4);

  // The zip is filed as a document and the link the page shows really serves it.
  await page.getByTestId('accounting-export').click();
  await expect(page.getByTestId('accounting-exported')).toBeVisible();
  const href = await page.getByTestId('accounting-export-download').getAttribute('href');
  const zip = await page.request.get(href!);
  expect(zip.status()).toBe(200);
  expect(zip.headers()['content-type']).toBe('application/zip');
  expect((await zip.body()).byteLength).toBeGreaterThan(200);

  // Closing an already-ended month records it. It refuses nothing else: a payment booked into that
  // very month, entered only now (after the close), still records — the invariant closing exists to
  // not break.
  await page.getByTestId('accounting-period').fill(CLOSED_PERIOD);
  await page.getByTestId('accounting-close').click();
  await expect(page.getByTestId('accounting-period-row')).toHaveCount(1);
  const late = await page.request.post(`${API}/api/invoices/${invoices.rows[0].id}/payments`, {
    data: { amountMinor: 1000, method: 'cash', paidAt: `${CLOSED_PERIOD}-20T10:00:00.000Z` },
  });
  expect(late.status()).toBe(201);

  await page.getByTestId('accounting-reopen').click();
  await expect(page.getByTestId('accounting-period-row')).toHaveCount(0);
});
