import { unzipSync, strFromU8 } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaffUser, registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

let t: Awaited<ReturnType<typeof createTestApp>>;
let cookie: string;
let readonlyCookie: string;
let technicianCookie: string;
let buildingId: string;

beforeAll(async () => {
  t = await createTestApp();
  const reg = await registerTenant(t.app, 'acct-export');
  cookie = reg.cookie;
  readonlyCookie = (await createStaffUser(t.app, cookie, 'acct-export', { email: 'r@acct-export.mk', firstName: 'R', lastName: 'O', role: 'readonly' })).cookie;
  technicianCookie = (await createStaffUser(t.app, cookie, 'acct-export', { email: 'tech@acct-export.mk', firstName: 'T', lastName: 'O', role: 'technician' })).cookie;
  const post = async (url: string, payload: unknown = {}) => {
    const res = await t.app.inject({ method: 'POST', url, headers: { cookie }, payload: payload as never });
    if (res.statusCode >= 300) throw new Error(`${url} → ${res.body}`);
    return res.json();
  };
  const rates = (await t.app.inject({ method: 'GET', url: '/api/tax-rates', headers: { cookie } })).json();
  const vatId = rates.rows.find((r: { rateBp: number }) => r.rateBp === 1800).id;
  const owner = await post('/api/contacts', { firstName: 'Ана', lastName: 'Анева' });
  const building = await post('/api/buildings', { name: 'Илинденска 7', address: 'Илинденска 7', city: 'Скопје', postalCode: '1000' });
  buildingId = building.id;
  await post(`/api/buildings/${buildingId}/units`, { label: '1', kind: 'apartment', areaM2: 60, ownerContactId: owner.id });
  const service = await post('/api/services', { name: 'Чистење', pricing: 'fixed_per_unit', defaultPriceMinor: 100000, taxRateId: vatId, appliesTo: ['apartment'] });
  await post(`/api/buildings/${buildingId}/services`, { serviceId: service.id, startsPeriod: '2026-01' });
  const period = await post(`/api/buildings/${buildingId}/periods`, { period: '2026-09' });
  await post(`/api/buildings/${buildingId}/periods/${period.id}/generate`);
  await post(`/api/buildings/${buildingId}/periods/${period.id}/publish`);
  await post(`/api/buildings/${buildingId}/reserve-fund/expenses`, {
    fund: 'regular', description: 'Струја', amountMinor: 40000, paidAt: new Date().toISOString(),
  });
  const slots: [string, string, string][] = [
    ['owner_receivable', '1200', 'Побарувања'], ['revenue_service', '7400', 'Приходи од услуги'],
    ['revenue_management_fee', '7410', 'Приходи од управување'], ['revenue_reserve_fund', '7420', 'Резервен фонд'],
    ['vat_output', '4700', 'ДДВ на излез'], ['cash_regular', '1000', 'Редовна сметка'],
    ['cash_reserve', '1001', 'Резервна сметка'], ['expense_default', '4000', 'Трошоци'], ['opening_balance', '9000', 'Почетна состојба'],
  ];
  for (const [slot, code, name] of slots) {
    await t.app.inject({ method: 'PUT', url: `/api/account-codes/${slot}`, headers: { cookie }, payload: { code, name } });
  }
});
afterAll(async () => { await t.close(); });

const WINDOW = { from: '2026-01-01', to: '2027-01-01' };

describe('POST /api/accounting/export', () => {
  it('is refused to a readonly user', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/accounting/export', headers: { cookie: readonlyCookie }, payload: WINDOW });
    expect(res.statusCode).toBe(403);
  });

  it('files a zip as a document and hands back its id', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/accounting/export', headers: { cookie }, payload: { ...WINDOW, buildingId } });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.debitMinor).toBe(body.creditMinor);
    expect(body.entryCount).toBe(2);
    // The building id is appended (fix round 1, item 2): otherwise this export and the tenant-wide
    // one filed by 'GET /api/accounting/exports' below, of the same window, would file as two
    // identically named zips with different contents.
    expect(body.fileName).toBe(`smetkovodstvo-2026-01-01-2027-01-01-${buildingId}.zip`);

    const download = await t.app.inject({ method: 'GET', url: `/api/documents/${body.documentId}/download`, headers: { cookie } });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toBe('application/zip');

    const files = unzipSync(new Uint8Array(download.rawPayload));
    expect(Object.keys(files).sort()).toEqual(['README.txt', 'bruto-bilans.csv', 'dnevnik.csv']);

    const journalBytes = files['dnevnik.csv']!;
    // the BOM Excel needs for a `;` file in Macedonian — checked on the bytes, not the decoded
    // string: `strFromU8` decodes through `TextDecoder`, which swallows a leading one (see the same
    // gotcha noted in reports-handover.test.ts).
    expect([...journalBytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const [header, ...lines] = strFromU8(journalBytes.subarray(3)).trim().split('\n');
    expect(header).toBe('ставка;датум;период;конто;назив;должи;побарува;опис;зграда;партнер;извор;извор-ид');
    // Entry order is by civil day then refType, and both events are dated today, so find the rows
    // by their account rather than by position: the figures are the point, not the sequence.
    const cells = lines.map((l) => l.split(';'));
    const receivable = cells.find((c) => c[3] === '1200')!;
    expect([receivable[2], receivable[4], receivable[5], receivable[6]]).toEqual(['2026-09', 'Побарувања', '1.180,00', '0,00']);
    expect(cells.some((c) => c[3] === '4000' && c[4] === 'Трошоци' && c[5] === '400,00')).toBe(true);

    const trialBytes = files['bruto-bilans.csv']!;
    expect([...trialBytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const trial = strFromU8(trialBytes.subarray(3)).trim().split('\n');
    expect(trial[0]).toBe('конто;назив;должи;побарува;разлика');
    expect(trial.at(-1)).toBe('ВКУПНО;;1.580,00;1.580,00;0,00');

    const readme = strFromU8(files['README.txt']!);
    expect(readme).toContain('Организација: Firma acct-export');
    expect(readme).toContain('Зграда: Илинденска 7');
    expect(readme).toContain('Ставки: 2');
    expect(readme).toContain('Должи: 1.580,00');
    expect(readme).toContain('Побарува: 1.580,00');
    expect(readme).toContain('Корекции од претходни периоди: 0');
    // The chart it used, slot by slot (controller ruling) — every mapped code and name appears.
    expect(readme).toContain('owner_receivable: 1200 — Побарувања');
    expect(readme).toContain('expense_default: 4000 — Трошоци');
  });

  it('GET /api/accounting/exports refuses a technician, who may not read a document either', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/accounting/exports', headers: { cookie: technicianCookie } });
    expect(res.statusCode).toBe(403);
  });

  // The preview is strictly more than the exports list — every account's debit and credit for any
  // window — and the period list is every closed month's stored totals, so both carry the same gate.
  it('refuses a technician the trial balance and the closed periods too', async () => {
    const preview = await t.app.inject({ method: 'GET', url: `/api/accounting/preview?from=${WINDOW.from}&to=${WINDOW.to}`, headers: { cookie: technicianCookie } });
    expect(preview.statusCode).toBe(403);
    const periods = await t.app.inject({ method: 'GET', url: '/api/accounting/periods', headers: { cookie: technicianCookie } });
    expect(periods.statusCode).toBe(403);
  });

  it('puts a late-booked prior-period posting in korekcii.csv, with its own README counts', async () => {
    const res0 = await t.app.inject({
      method: 'POST', url: `/api/buildings/${buildingId}/reserve-fund/expenses`, headers: { cookie },
      payload: { fund: 'regular', description: 'Стар трошок', amountMinor: 1000, paidAt: '2024-01-01T00:00:00.000Z' },
    });
    expect(res0.statusCode, res0.body).toBe(201);

    const res = await t.app.inject({ method: 'POST', url: '/api/accounting/export', headers: { cookie }, payload: { ...WINDOW, buildingId } });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.adjustmentCount).toBe(1);

    const download = await t.app.inject({ method: 'GET', url: `/api/documents/${body.documentId}/download`, headers: { cookie } });
    const files = unzipSync(new Uint8Array(download.rawPayload));
    expect(Object.keys(files).sort()).toEqual(['README.txt', 'bruto-bilans.csv', 'dnevnik.csv', 'korekcii.csv']);

    const korekciiBytes = files['korekcii.csv']!;
    expect([...korekciiBytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const [header, ...lines] = strFromU8(korekciiBytes.subarray(3)).trim().split('\n');
    expect(header).toBe('ставка;датум;период;конто;назив;должи;побарува;опис;зграда;партнер;извор;извор-ид;затворен-период');
    // No period-close feature exists yet, so nothing this window covers is closed.
    expect(lines.every((l) => l.endsWith(';не'))).toBe(true);
    expect(lines.some((l) => l.split(';')[3] === '4000')).toBe(true);

    const readme = strFromU8(files['README.txt']!);
    // Still the two entries booked inside the window — the adjustment is not one of them (item 1).
    expect(readme).toContain('Ставки: 2');
    expect(readme).toContain('Корекции од претходни периоди: 1');
    expect(readme).toContain('Редови на корекции: 2');
  });

  it('refuses while the chart is incomplete, naming every missing slot', async () => {
    const other = await registerTenant(t.app, 'acct-export-2');
    const res = await t.app.inject({ method: 'POST', url: '/api/accounting/export', headers: { cookie: other.cookie }, payload: WINDOW });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('chart_incomplete');
    expect(res.json().error.details.missing).toHaveLength(9);
  });

  it('writes an audit row naming the document', async () => {
    const rows = await t.db.query.auditLogs.findMany({});
    expect(rows.some((r) => r.action === 'accounting.export')).toBe(true);
  });
});

describe('GET /api/accounting/exports', () => {
  it('lists a tenant-wide export, which has no building to be listed under', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/accounting/export', headers: { cookie }, payload: WINDOW });
    expect(res.statusCode).toBe(201);
    const documentId = res.json().documentId;

    const list = await t.app.inject({ method: 'GET', url: '/api/accounting/exports', headers: { cookie } });
    expect(list.statusCode).toBe(200);
    const row = list.json().rows.find((r: { documentId: string }) => r.documentId === documentId);
    expect(row).toBeTruthy();
    expect(row.buildingId).toBeNull();
    expect(row.fileName).toBe('smetkovodstvo-2026-01-01-2027-01-01.zip');
  });
});
