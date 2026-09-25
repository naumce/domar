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

export interface ReportBuilding extends PublishedBuilding {
  /** The tenant's civil year, which is the year every figure this fixture sets up falls in. */
  year: number;
  paymentId: string;
  supplierId: string;
  expenses: { regularId: string; reserveId: string };
}

/**
 * The billing-core building with the year's money actually moved: owner O1 pays their invoice in
 * full, 500,00 den leaves the regular fund and 1.200,00 den leaves the reserve fund as works.
 * Everything is stamped `now`, because publishing a period books its charges at the moment of
 * publishing — dating the payments and the expenses to the same instant is what keeps the whole
 * fixture inside one civil year whenever the suite runs.
 */
export async function setupReportBuilding(app: FastifyInstance, cookie: string): Promise<ReportBuilding> {
  const h = { cookie };
  const post = (url: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url, headers: h, payload });
  const base = await setupPublishedBuilding(app, cookie);
  // The tenant's zone, not the server's: a report window is civil, and the two differ for an hour
  // either side of New Year in Skopje.
  const year = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Skopje', year: 'numeric' }).format(new Date()));
  const now = Date.now();
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  const supplierId = (await post('/api/suppliers', { name: 'Кровови ДООЕЛ' })).json().id;
  const paymentId = (await post(`/api/invoices/${base.invoices.O1.id}/payments`, {
    amountMinor: base.invoices.O1.totalMinor, method: 'bank_transfer', paidAt: at(3000), reference: 'ПЛ-1',
  })).json().payment.id;
  const regularId = (await post(`/api/buildings/${base.buildingId}/reserve-fund/expenses`, {
    fund: 'regular', description: 'Струја за заедничките простории', supplierText: 'ЕВН Македонија',
    amountMinor: 50_000, paidAt: at(2000),
  })).json().id;
  const reserveId = (await post(`/api/buildings/${base.buildingId}/reserve-fund/expenses`, {
    fund: 'reserve', description: 'Санација на кровот', supplierId, amountMinor: 120_000, paidAt: at(1000),
  })).json().id;
  return { ...base, year, paymentId, supplierId, expenses: { regularId, reserveId } };
}
