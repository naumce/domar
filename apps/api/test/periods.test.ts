import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

describe('billing periods', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let buildingId: string; let vatId: string; let cleaningId: string; let liftId: string;
  const h = () => ({ cookie: a.cookie });
  const P = (s = '') => `/api/buildings/${buildingId}/periods${s}`;
  beforeAll(async () => {
    t = await createTestApp();
    a = await registerTenant(t.app, 'firma-a');
    vatId = (await t.app.inject({ method: 'GET', url: '/api/tax-rates', headers: h() })).json().rows.find((r: { rateBp: number }) => r.rateBp === 1800).id;
    buildingId = (await t.app.inject({ method: 'POST', url: '/api/buildings', headers: h(), payload: { name: 'Зграда 1' } })).json().id;
    cleaningId = (await t.app.inject({ method: 'POST', url: '/api/services', headers: h(), payload: { name: 'Чистење', pricing: 'fixed_per_unit', defaultPriceMinor: 30000, taxRateId: vatId, appliesTo: ['apartment', 'commercial'] } })).json().id;
    liftId = (await t.app.inject({ method: 'POST', url: '/api/services', headers: h(), payload: { name: 'Лифт', pricing: 'shared_total', defaultPriceMinor: 600000, taxRateId: vatId } })).json().id;
    await t.app.inject({ method: 'POST', url: `/api/buildings/${buildingId}/services`, headers: h(), payload: { serviceId: cleaningId, startsPeriod: '2026-01' } });
    await t.app.inject({ method: 'POST', url: `/api/buildings/${buildingId}/services`, headers: h(), payload: { serviceId: liftId, startsPeriod: '2026-01', frequency: 'every_n_months', intervalMonths: 3 } });
  });
  afterAll(async () => { await t.close(); });

  it('creates a period with auto lines from due building services', async () => {
    const feb = await t.app.inject({ method: 'POST', url: P(), headers: h(), payload: { period: '2026-02' } });
    expect(feb.statusCode).toBe(201);
    expect(feb.json()).toMatchObject({ period: '2026-02', status: 'open', currency: 'MKD', managementFeeMinor: 0, managementFeeAppliesTo: ['apartment', 'commercial'], invoiceCount: 0 });
    expect(feb.json().lines.map((l: { description: string; source: string }) => [l.description, l.source])).toEqual([['Чистење', 'auto']]);
    const apr = await t.app.inject({ method: 'POST', url: P(), headers: h(), payload: { period: '2026-04', managementFeeMinor: 15000, managementFeeTaxRateId: vatId } });
    expect(apr.json()).toMatchObject({ managementFeeMinor: 15000, managementFeeTaxRateBp: 1800 });
    expect(apr.json().lines.map((l: { description: string; pricing: string; unitPriceMinor: number; taxRateBp: number }) => [l.description, l.pricing, l.unitPriceMinor, l.taxRateBp]))
      .toEqual([['Чистење', 'fixed_per_unit', 30000, 1800], ['Лифт', 'shared_total', 600000, 1800]]);
  });

  it('rejects duplicate periods and bad period strings', async () => {
    expect((await t.app.inject({ method: 'POST', url: P(), headers: h(), payload: { period: '2026-02' } })).statusCode).toBe(409);
    expect((await t.app.inject({ method: 'POST', url: P(), headers: h(), payload: { period: '2026-13' } })).statusCode).toBe(400);
  });

  it('adds manual lines from a service or free text', async () => {
    const id = (await t.app.inject({ method: 'GET', url: P(), headers: h() })).json().rows.find((p: { period: string }) => p.period === '2026-02').id;
    const fromService = await t.app.inject({ method: 'POST', url: P(`/${id}/lines`), headers: h(), payload: { serviceId: liftId, quantity: 0.5 } });
    expect(fromService.statusCode).toBe(201);
    expect(fromService.json()).toMatchObject({ description: 'Лифт', pricing: 'shared_total', unitPriceMinor: 600000, taxRateBp: 1800, quantity: 0.5, source: 'manual', fund: 'regular' });
    const free = await t.app.inject({ method: 'POST', url: P(`/${id}/lines`), headers: h(), payload: { description: 'Замена брава', pricing: 'fixed_per_unit', unitPriceMinor: 2500, appliesTo: ['apartment'], fund: 'regular' } });
    expect(free.statusCode).toBe(201);
    expect(free.json()).toMatchObject({ serviceId: null, taxRateBp: 0, appliesTo: ['apartment'] });
    expect((await t.app.inject({ method: 'POST', url: P(`/${id}/lines`), headers: h(), payload: { quantity: 2 } })).statusCode).toBe(400);
  });

  it('requires a note to edit an auto line and flips it to manual; refresh keeps manual lines', async () => {
    const id = (await t.app.inject({ method: 'GET', url: P(), headers: h() })).json().rows.find((p: { period: string }) => p.period === '2026-02').id;
    const detail = (await t.app.inject({ method: 'GET', url: P(`/${id}`), headers: h() })).json();
    const auto = detail.lines.find((l: { source: string }) => l.source === 'auto');
    const noNote = await t.app.inject({ method: 'PATCH', url: P(`/${id}/lines/${auto.id}`), headers: h(), payload: { unitPriceMinor: 32000 } });
    expect(noNote.statusCode).toBe(400);
    expect(noNote.json().error.code).toBe('note_required');
    const withNote = await t.app.inject({ method: 'PATCH', url: P(`/${id}/lines/${auto.id}`), headers: h(), payload: { unitPriceMinor: 32000, note: 'договорено попуст' } });
    expect(withNote.json()).toMatchObject({ unitPriceMinor: 32000, source: 'manual', note: 'договорено попуст' });
    const refreshed = (await t.app.inject({ method: 'POST', url: P(`/${id}/refresh-lines`), headers: h() })).json();
    const descs = refreshed.lines.map((l: { description: string; source: string; unitPriceMinor: number }) => `${l.description}:${l.source}:${l.unitPriceMinor}`);
    expect(descs).toContain('Чистење:auto:30000');   // rebuilt auto line
    expect(descs).toContain('Чистење:manual:32000'); // the edited copy survives as manual
    expect(descs).toContain('Замена брава:manual:2500');
    const del = await t.app.inject({ method: 'DELETE', url: P(`/${id}/lines/${refreshed.lines.find((l: { description: string }) => l.description === 'Замена брава').id}`), headers: h() });
    expect(del.statusCode).toBe(204);
  });

  it('updates fee and numbering, lists periods, and is tenant isolated', async () => {
    const rows = (await t.app.inject({ method: 'GET', url: P(), headers: h() })).json().rows;
    expect(rows.map((p: { period: string }) => p.period)).toEqual(['2026-04', '2026-02']);
    const id = rows[1].id;
    const upd = await t.app.inject({ method: 'PATCH', url: P(`/${id}`), headers: h(), payload: { numberPrefix: 'F-', numberSuffix: '/{year}-A', managementFeeMinor: 12000, managementFeeTaxRateId: null, managementFeeAppliesTo: ['apartment'] } });
    expect(upd.json()).toMatchObject({ numberPrefix: 'F-', numberSuffix: '/{year}-A', managementFeeMinor: 12000, managementFeeTaxRateBp: 0, managementFeeAppliesTo: ['apartment'] });
    const b = await registerTenant(t.app, 'firma-b');
    expect((await t.app.inject({ method: 'GET', url: P(`/${id}`), headers: { cookie: b.cookie } })).statusCode).toBe(404);
  });
});
