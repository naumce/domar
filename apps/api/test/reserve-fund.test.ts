import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

describe('reserve fund', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let buildingId: string;
  const url = (s = '') => `/api/buildings/${buildingId}/reserve-fund${s}`;
  beforeAll(async () => {
    t = await createTestApp();
    a = await registerTenant(t.app, 'firma-a');
    buildingId = (await t.app.inject({ method: 'POST', url: '/api/buildings', headers: { cookie: a.cookie }, payload: { name: 'Зграда 1' } })).json().id;
  });
  afterAll(async () => { await t.close(); });

  it('starts with no setting and zero balance', async () => {
    const res = await t.app.inject({ method: 'GET', url: url(), headers: { cookie: a.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ setting: null, balanceMinor: 0, contributionsBilledMinor: 0 });
  });

  it('upserts the setting', async () => {
    const put = await t.app.inject({ method: 'PUT', url: url(), headers: { cookie: a.cookie }, payload: { basis: 'per_m2', amountMinor: 1000, appliesTo: ['apartment', 'commercial'], active: true } });
    expect(put.statusCode).toBe(200);
    expect(put.json().setting).toMatchObject({ basis: 'per_m2', amountMinor: 1000, appliesTo: ['apartment', 'commercial'], active: true });
    const again = await t.app.inject({ method: 'PUT', url: url(), headers: { cookie: a.cookie }, payload: { basis: 'per_unit', amountMinor: 50000, appliesTo: [], active: true } });
    expect(again.json().setting).toMatchObject({ basis: 'per_unit', amountMinor: 50000 });
  });

  it('records an opening balance, expenses and voids, and computes the balance', async () => {
    const open = await t.app.inject({ method: 'POST', url: url('/opening-balance'), headers: { cookie: a.cookie }, payload: { amountMinor: 3500000, note: 'Пренос од претходен управител' } });
    expect(open.statusCode).toBe(201);
    const exp = await t.app.inject({ method: 'POST', url: url('/expenses'), headers: { cookie: a.cookie }, payload: { fund: 'reserve', description: 'Поправка кров', supplierText: 'Кровопокривач ДООЕЛ', amountMinor: 1200000, paidAt: '2026-09-10T10:00:00.000Z' } });
    expect(exp.statusCode).toBe(201);
    const exp2 = await t.app.inject({ method: 'POST', url: url('/expenses'), headers: { cookie: a.cookie }, payload: { fund: 'reserve', description: 'Грешка', amountMinor: 100, paidAt: '2026-09-11T10:00:00.000Z' } });
    let state = (await t.app.inject({ method: 'GET', url: url(), headers: { cookie: a.cookie } })).json();
    expect(state.balanceMinor).toBe(3500000 - 1200000 - 100);
    const voided = await t.app.inject({ method: 'POST', url: url(`/expenses/${exp2.json().id}/void`), headers: { cookie: a.cookie }, payload: { reason: 'дупликат' } });
    expect(voided.statusCode).toBe(200);
    expect(voided.json()).toMatchObject({ voidReason: 'дупликат' });
    state = (await t.app.inject({ method: 'GET', url: url(), headers: { cookie: a.cookie } })).json();
    expect(state.balanceMinor).toBe(2300000);
    const tx = await t.app.inject({ method: 'GET', url: url('/transactions'), headers: { cookie: a.cookie } });
    type TxRow = { kind: string; amountMinor: number; description: string | null };
    const txRows: TxRow[] = tx.json().rows;
    // Order is `desc(bookedAt), desc(createdAt)`. The opening balance and the void adjustment are
    // both booked "now" (no explicit bookedAt), while the expenses are booked at their `paidAt`
    // (2026-09-10/11), which is in the past relative to "now" — so the exact ordering across the
    // two now-booked rows is not guaranteed by insertion order alone. Assert the set of rows
    // instead of a specific order between them.
    expect(txRows.map((r) => [r.kind, r.amountMinor]).sort()).toEqual([['adjustment', 100], ['expense', -1200000], ['expense', -100], ['opening', 3500000]].sort());
    // The two "now"-booked rows (opening, adjustment) must both sort ahead of the two past-dated
    // expense rows.
    const kindIndex = (kind: string) => txRows.findIndex((r) => r.kind === kind);
    const expenseIndices = txRows.flatMap((r, i) => (r.kind === 'expense' ? [i] : []));
    expect(Math.max(kindIndex('opening'), kindIndex('adjustment'))).toBeLessThan(Math.min(...expenseIndices));
    expect(txRows.find((r) => r.amountMinor === -1200000)?.description).toBe('Поправка кров');
    expect(txRows.find((r) => r.kind === 'adjustment')?.description).toBe('Грешка');
    const expenses = await t.app.inject({ method: 'GET', url: url('/expenses'), headers: { cookie: a.cookie } });
    expect(expenses.json().rows).toHaveLength(2);
    expect(expenses.json().rows.find((e: { id: string }) => e.id === exp2.json().id).voidedAt).not.toBeNull();
  });

  it('rejects voiding twice, non-positive amounts, and foreign tenants', async () => {
    const expenses = (await t.app.inject({ method: 'GET', url: url('/expenses'), headers: { cookie: a.cookie } })).json().rows;
    const voided = expenses.find((e: { voidedAt: string | null }) => e.voidedAt);
    expect((await t.app.inject({ method: 'POST', url: url(`/expenses/${voided.id}/void`), headers: { cookie: a.cookie }, payload: { reason: 'x' } })).statusCode).toBe(409);
    expect((await t.app.inject({ method: 'POST', url: url('/expenses'), headers: { cookie: a.cookie }, payload: { fund: 'regular', description: 'x', amountMinor: 0, paidAt: '2026-09-11T10:00:00.000Z' } })).statusCode).toBe(400);
    const b = await registerTenant(t.app, 'firma-b');
    expect((await t.app.inject({ method: 'GET', url: url(), headers: { cookie: b.cookie } })).statusCode).toBe(404);
  });
});
