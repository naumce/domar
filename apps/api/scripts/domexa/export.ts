import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DomexaClient } from './client.js';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const idOf = (v: unknown): string => (isRecord(v) && (typeof v.id === 'string' || typeof v.id === 'number') ? String(v.id) : '');

/**
 * Raw GET responses, written verbatim. Nothing here interprets a field — that is Task 3's job — and
 * nothing here writes a credential into the folder (spec §20.4). A 404 or a 403 on one sub-resource
 * leaves a null behind and the export continues; a demo account has whole endpoints missing.
 */
export async function runExport(client: DomexaClient, dir: string, log: (l: string) => void = console.log): Promise<void> {
  await mkdir(dir, { recursive: true });
  const write = async (name: string, data: unknown): Promise<void> => {
    await writeFile(join(dir, name), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    log(`wrote ${name}`);
  };
  const soft = async <T>(what: string, fn: () => Promise<T>): Promise<T | null> => {
    try { return await fn(); } catch (e) { log(`skipped ${what}: ${(e as Error).message}`); return null; }
  };

  await client.login();
  await write('organization.json', await soft('/api/organization', () => client.get('/api/organization')));
  await write('tax-rates.json', (await soft('/api/tax-rates', () => client.getAll('/api/tax-rates'))) ?? []);
  await write('services.json', (await soft('/api/services', () => client.getAll('/api/services'))) ?? []);
  await write('service-categories.json', (await soft('/api/service-categories', () => client.getAll('/api/service-categories'))) ?? []);

  // A sub-resource that failed is written as null, never as an empty list: `transform` must be able
  // to tell "this building has no units" from "the units were never exported" (docs/MIGRATION.md).
  const contacts = await soft('/api/contacts', () => client.getAll('/api/contacts'));
  await write('contacts.json', contacts);
  let statements: Record<string, unknown> | null = null;
  if (contacts !== null) {
    statements = {};
    for (const c of contacts) {
      const id = idOf(c);
      if (id) statements[id] = await soft(`/api/contacts/${id}/statement`, () => client.get(`/api/contacts/${id}/statement`));
    }
  }
  await write('statements.json', statements);

  const buildings = (await soft('/api/buildings', () => client.getAll('/api/buildings'))) ?? [];
  await write('buildings.json', buildings);
  const units: Record<string, unknown> = {};
  const buildingServices: Record<string, unknown> = {};
  const reserveFunds: Record<string, unknown> = {};
  const reserveFundBalances: Record<string, unknown> = {};
  for (const b of buildings) {
    const id = idOf(b);
    if (!id) continue;
    units[id] = await soft(`/api/buildings/${id}/units`, () => client.getAll(`/api/buildings/${id}/units`));
    buildingServices[id] = await soft(`/api/buildings/${id}/services`, () => client.getAll(`/api/buildings/${id}/services`));
    reserveFunds[id] = await soft(`/api/buildings/${id}/reserve-fund`, () => client.get(`/api/buildings/${id}/reserve-fund`));
    reserveFundBalances[id] = await soft(`/api/buildings/${id}/reserve-fund/balance`, () => client.get(`/api/buildings/${id}/reserve-fund/balance`));
  }
  await write('units.json', units);
  await write('building-services.json', buildingServices);
  await write('reserve-funds.json', reserveFunds);
  await write('reserve-fund-balances.json', reserveFundBalances);
}
