import { expect, test } from '@playwright/test';

const API = 'http://localhost:3001';
const slug = `e2e-sobir-${Date.now().toString(36)}`;
const password = 'correct-horse-1';
const ownerPassword = 'battery-staple-7';
/** Twenty days out: Art. 37's fifteen with room to spare, so the invitation is never late. */
const scheduledAt = new Date(Date.now() + 20 * 86_400_000);
/** `datetime-local` wants a local wall-clock string without a zone or seconds. */
const localInput = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

test('a manager calls an assembly, an owner votes in the portal, the minutes are filed and the Art. 37 card flags the same-day hold', async ({ page, browser }) => {
  // --- manager ---
  await page.goto('/register');
  await page.getByTestId('orgName').fill('Е2Е Собир');
  await page.getByTestId('slug').fill(slug);
  await page.getByTestId('firstName').fill('Ива');
  await page.getByTestId('lastName').fill('Тест');
  await page.getByTestId('email').fill(`iva@${slug}.mk`);
  await page.getByTestId('password').fill(password);
  await page.getByRole('button', { name: /Отвори сметка|Create account/ }).click();
  await expect(page).toHaveURL(/\/app$/);

  // Seed through the API with the session cookie the registration just set.
  const post = async (path: string, data: unknown = {}) => {
    const res = await page.request.post(`${API}${path}`, { data });
    expect(res.status(), `${path} → ${await res.text()}`).toBeLessThan(300);
    return res.json();
  };
  const o1 = await post('/api/contacts', { firstName: 'Марко', lastName: 'Марков', email: `marko@${slug}.mk` });
  const o2 = await post('/api/contacts', { firstName: 'Ана', lastName: 'Анева' });
  const building = await post('/api/buildings', { name: 'Востаничка 7', address: 'Востаничка 7', city: 'Скопје', postalCode: '1000' });
  // 0.6 / 0.4 → 6000 / 4000 basis points of 10000.
  await post(`/api/buildings/${building.id}/units`, { label: '1', kind: 'apartment', areaM2: 60, ownershipShare: 0.6, ownerContactId: o1.id });
  await post(`/api/buildings/${building.id}/units`, { label: '2', kind: 'apartment', areaM2: 40, ownershipShare: 0.4, ownerContactId: o2.id });

  // Issue the portal code from the manager UI and read it off the screen (shown exactly once).
  await page.goto(`/app/contacts/${o1.id}`);
  await page.getByTestId('portal-issue').click();
  const code = (await page.getByTestId('portal-issued-code').innerText()).trim();
  expect(code).toMatch(/^[A-HJ-NP-Za-km-z2-9]{8}$/);

  // Schedule the assembly twenty days out, with one agenda point and two decisions.
  await page.goto(`/app/buildings/${building.id}?tab=assemblies`);
  await page.getByTestId('assembly-scheduled').fill(localInput(scheduledAt));
  await page.getByTestId('assembly-location').fill('Влез А, приземје');
  await page.getByTestId('assembly-quorum').selectOption('share');
  await page.getByTestId('assembly-agenda-title').first().fill('Годишен извештај за 2025');
  await page.getByTestId('assembly-decision-add').click();
  await page.getByTestId('assembly-decision-title').nth(0).fill('Усвојување на извештајот');
  await page.getByTestId('assembly-decision-title').nth(1).fill('Санација на кровот');
  await page.getByTestId('assembly-create').click();
  await expect(page.getByTestId('assembly-status')).toHaveText('Нацрт');

  // Call it: one email invitation (the json mailer is configured in the e2e API) and one letter.
  await page.getByTestId('assembly-invite').click();
  await expect(page.getByTestId('assembly-status')).toHaveText('Свикан');
  await expect(page.getByTestId('invitation-row')).toHaveCount(2);
  await expect(page.getByTestId('assembly-late-badge')).toHaveCount(0);
  const assemblies = await (await page.request.get(`${API}/api/buildings/${building.id}/assemblies`)).json();
  const assemblyId = assemblies.rows[0].id;

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

    await owners.getByTestId('portal-nav-assemblies').click();
    await expect(owners.getByTestId('portal-assembly-row')).toHaveCount(1);
    await expect(owners.getByTestId('portal-assembly-status')).toHaveText('Свикан');
    await owners.getByTestId('portal-assembly-link').click();
    await expect(owners).toHaveURL(new RegExp(`/portal/assemblies/${assemblyId}$`));
    await expect(owners.getByTestId('portal-assembly-agenda')).toContainText('Годишен извештај за 2025');
    await expect(owners.getByTestId('portal-assembly-decision')).toHaveCount(2);

    // Vote "for" on both decisions; the running tally stays invisible while the ballot is open.
    await owners.getByTestId('portal-assembly-decision').nth(0).getByTestId('portal-vote-for').click();
    await expect(owners.getByTestId('portal-assembly-mychoice').first()).toHaveText('Вашиот глас: За');
    await owners.getByTestId('portal-assembly-decision').nth(1).getByTestId('portal-vote-for').click();
    await expect(owners.getByTestId('portal-assembly-mychoice')).toHaveCount(2);
    await expect(owners.getByTestId('portal-assembly-result')).toHaveCount(0);

    // --- the manager holds it ---
    // Not on the scheduled date: `holdAssembly` now rejects a future `heldAt` (400 `held_in_the_future`),
    // and the web form sends `heldAt = now` whenever the field is left blank (AssemblyPanel.vue's `hold()`),
    // so an assembly scheduled twenty days out is necessarily closed early, today, from this UI. That is
    // allowed as long as `heldAt >= invitedAt`, which it is here.
    await page.reload();
    await page.getByTestId('assembly-open').click();
    await expect(page.getByTestId('attendance-row')).toHaveCount(2);
    await page.getByTestId(`attendance-present-${o1.id}`).check();
    await page.getByTestId(`attendance-present-${o2.id}`).check();
    await page.getByTestId('assembly-hold').click();
    await expect(page.getByTestId('assembly-status')).toHaveText('Одржан');
    // 6000 for, 0 against, both owners present out of 10000 → passed.
    await expect(page.getByTestId('decision-result').first()).toHaveText('Усвоена');
    await expect(page.getByTestId('assembly-quorum-line')).toContainText('10000');

    // The minutes are a real PDF the manager can download…
    const minutes = await page.getByTestId('assembly-minutes').getAttribute('href');
    const managerPdf = await page.request.get(minutes!);
    expect(managerPdf.status()).toBe(200);
    expect((await managerPdf.body()).subarray(0, 4).toString()).toBe('%PDF');

    // …and the owner sees the result and the same minutes in the portal.
    await owners.reload();
    await expect(owners.getByTestId('portal-assembly-closed')).toBeVisible();
    await expect(owners.getByTestId('portal-assembly-result').first()).toContainText('Усвоена');
    await expect(owners.getByTestId('portal-assembly-result').first()).toContainText('6000');
    await expect(owners.getByTestId('portal-vote-for')).toHaveCount(0);
    const ownerMinutes = await owners.getByTestId('portal-assembly-minutes').getAttribute('href');
    expect(ownerMinutes).toContain(`contactId=${o1.id}`);
    const ownerPdf = await owners.request.get(ownerMinutes!);
    expect(ownerPdf.status()).toBe(200);
    expect((await ownerPdf.body()).subarray(0, 4).toString()).toBe('%PDF');
  } finally {
    await ownerContext.close();
  }

  // The Art. 37 card reads the *actual* gap between the invitation and the hold, not the original
  // schedule (packages/domain/src/compliance/evaluate.ts's `assemblyDuty`, fed by
  // apps/api/src/resources/compliance/snapshot.ts's `lastAssemblyInvitedAt`/`lastAssemblyHeldAt`, both
  // taken off this same held assembly's own rows). Because the hold above happened minutes after the
  // invitation rather than the twenty days the schedule announced, that gap is zero civil days — genuinely
  // short of Art. 37's fifteen — so the card is `due` with the `late_invitation` flag, not `ok`. The deep
  // link and the event itself are unaffected.
  await page.goto(`/app/buildings/${building.id}?tab=compliance`);
  await expect(page.getByTestId('compliance-card-assembly-status')).toHaveText('Доспева');
  await expect(page.locator('[data-test=compliance-card-assembly] [data-test=compliance-flag]')).toHaveCount(1);
  await expect(page.getByTestId('compliance-fix-assembly')).toHaveAttribute('href', `/app/buildings/${building.id}?tab=assemblies`);
  await expect(page.getByTestId('compliance-event').first()).toContainText('Одржан собир');

  // And the minutes are filed as a document of the building.
  await page.goto(`/app/buildings/${building.id}?tab=documents`);
  await expect(page.getByTestId('row')).toHaveCount(1);
  await expect(page.getByTestId('row')).toContainText('Записник');
});
