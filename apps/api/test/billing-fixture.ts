import type { FastifyInstance } from 'fastify';

export type OwnerKey = 'O1' | 'O2' | 'O3';
export interface PublishedBuilding {
  buildingId: string;
  periodId: string;
  owners: Record<OwnerKey, string>;
  invoices: Record<OwnerKey, { id: string; number: string; totalMinor: number }>;
}

/** The billing-core fixture: three owners, five units, two services, a reserve fund and a published 2026-09 period. */
export async function setupPublishedBuilding(app: FastifyInstance, cookie: string, opts: { dueAt?: string } = {}): Promise<PublishedBuilding> {
  const h = { cookie };
  const post = (url: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url, headers: h, payload });
  const get = (url: string) => app.inject({ method: 'GET', url, headers: h });

  const vatId = (await get('/api/tax-rates')).json().rows.find((r: { rateBp: number }) => r.rateBp === 1800).id;
  const owners = {} as Record<OwnerKey, string>;
  for (const [k, ln] of [['O1', 'Анѓеловски'], ['O2', 'Бошковски'], ['O3', 'Велковски']] as const) {
    owners[k] = (await post('/api/contacts', { firstName: 'Тест', lastName: ln })).json().id;
  }
  const buildingId = (await post('/api/buildings', { name: 'Партизанска 12', shareBasis: 'area' })).json().id;
  const U = (p: Record<string, unknown>) => post(`/api/buildings/${buildingId}/units`, p);
  const A = (await U({ label: '1', kind: 'apartment', areaM2: 50, ownerContactId: owners.O1 })).json().id;
  await U({ label: '2', kind: 'apartment', areaM2: 75, ownerContactId: owners.O2 });
  await U({ label: 'L1', kind: 'commercial', areaM2: 100, ownerContactId: owners.O3 });
  await U({ label: 'P-1', kind: 'parking', attachedToUnitId: A });
  await U({ label: 'S-1', kind: 'storage', areaM2: 10 });
  const cleaning = (await post('/api/services', { name: 'Чистење', pricing: 'fixed_per_unit', defaultPriceMinor: 30000, taxRateId: vatId, appliesTo: ['apartment', 'commercial'] })).json().id;
  const lift = (await post('/api/services', { name: 'Лифт', pricing: 'shared_total', defaultPriceMinor: 600000, taxRateId: vatId })).json().id;
  await post(`/api/buildings/${buildingId}/services`, { serviceId: cleaning, startsPeriod: '2026-01' });
  await post(`/api/buildings/${buildingId}/services`, { serviceId: lift, startsPeriod: '2026-01' });
  await app.inject({ method: 'PUT', url: `/api/buildings/${buildingId}/reserve-fund`, headers: h, payload: { basis: 'per_m2', amountMinor: 1000, appliesTo: ['apartment', 'commercial'], active: true } });
  await post(`/api/buildings/${buildingId}/reserve-fund/opening-balance`, { amountMinor: 3500000 });
  const periodId = (await post(`/api/buildings/${buildingId}/periods`, { period: '2026-09', managementFeeMinor: 15000, managementFeeTaxRateId: vatId })).json().id;
  await post(`/api/buildings/${buildingId}/periods/${periodId}/lines`, { description: 'Осветлување паркинг', pricing: 'fixed_per_unit', unitPriceMinor: 2000, taxRateId: vatId, appliesTo: ['parking'] });
  await post(`/api/buildings/${buildingId}/periods/${periodId}/generate`, {});
  await post(`/api/buildings/${buildingId}/periods/${periodId}/publish`, opts.dueAt ? { dueAt: opts.dueAt } : {});

  const rows: { id: string; number: string; totalMinor: number; contactId: string }[] = (await get(`/api/invoices?buildingId=${buildingId}&period=2026-09`)).json().rows;
  const invoices = {} as PublishedBuilding['invoices'];
  for (const k of ['O1', 'O2', 'O3'] as const) {
    const r = rows.find((i) => i.contactId === owners[k]);
    if (!r) throw new Error(`no invoice for ${k}`);
    invoices[k] = { id: r.id, number: r.number, totalMinor: r.totalMinor };
  }
  return { buildingId, periodId, owners, invoices };
}

export type AssemblyOwnerKey = 'A' | 'B' | 'C';
export interface AssemblyBuilding { buildingId: string; owners: Record<AssemblyOwnerKey, string> }

/**
 * A building for Art. 37: three owners with explicit ownership shares — 0.5 / 0.3 / 0.2, i.e.
 * 5000 / 3000 / 2000 basis points out of 10000 — so a quorum can be tested exactly on 50 % (A alone)
 * and clearly above it (A + B). `emails` decides who gets an email invitation and who gets a letter.
 */
export async function setupAssemblyBuilding(app: FastifyInstance, cookie: string, emails: Partial<Record<AssemblyOwnerKey, string>> = {}): Promise<AssemblyBuilding> {
  const h = { cookie };
  const post = (url: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url, headers: h, payload });
  const people: [AssemblyOwnerKey, string, number, number][] = [['A', 'Анастасова', 0.5, 50], ['B', 'Богданов', 0.3, 30], ['C', 'Цветков', 0.2, 20]];
  const buildingId = (await post('/api/buildings', { name: 'Востаничка 7', address: 'Востаничка 7', city: 'Скопје', postalCode: '1000' })).json().id;
  const owners = {} as Record<AssemblyOwnerKey, string>;
  for (const [k, lastName, share, area] of people) {
    owners[k] = (await post('/api/contacts', { firstName: 'Тест', lastName, ...(emails[k] ? { email: emails[k] } : {}) })).json().id;
    await post(`/api/buildings/${buildingId}/units`, { label: k, kind: 'apartment', areaM2: area, ownershipShare: share, ownerContactId: owners[k] });
  }
  return { buildingId, owners };
}
