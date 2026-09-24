import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type DomexaClient, DomexaHttpError } from '../scripts/domexa/client.js';
import { runExport } from '../scripts/domexa/export.js';

const ROWS: Record<string, unknown> = {
  '/api/organization': { id: 1, name: 'Test kompanija' },
  '/api/tax-rates': [{ id: 'tr-18', name: 'ДДВ', rate: '18.00' }],
  '/api/services': [{ id: 's1', name: 'Чистење' }],
  '/api/contacts': [{ id: 'c1', firstName: 'Марко' }],
  '/api/contacts/c1/statement': { closingBalance: '1234.56' },
  '/api/buildings': [{ id: 'b1' }, { id: 'b7' }],
  '/api/buildings/b1/units': [{ id: 'u1', number: '1' }],
  '/api/buildings/b7/units': [{ id: 'u9', number: '9' }],
};

/** Answers from the table; a path in `failing` throws the way a timed-out request does (status 0). */
function fakeClient(failing: string[]): DomexaClient {
  const answer = (path: string): unknown => {
    if (failing.includes(path)) throw new DomexaHttpError(0, path, '');
    return ROWS[path] ?? null;
  };
  return {
    login: async () => {},
    get: async (path: string) => answer(path),
    getAll: async (path: string) => (answer(path) ?? []) as unknown[],
  } as unknown as DomexaClient;
}

const readJson = async (dir: string, name: string): Promise<unknown> => JSON.parse(await readFile(join(dir, name), 'utf8'));

describe('runExport', () => {
  it('writes null for a sub-resource that failed, never an empty list', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'domexa-export-'));
    await runExport(fakeClient(['/api/buildings/b7/units']), dir, () => {});

    // b1 really has one unit; b7's units are unknown, and must not read as "this building has none".
    expect(await readJson(dir, 'units.json')).toEqual({ b1: [{ id: 'u1', number: '1' }], b7: null });
    expect(await readJson(dir, 'building-services.json')).toEqual({ b1: [], b7: [] });
  });

  it('writes null for the contacts and their statements when the contact list failed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'domexa-export-'));
    await runExport(fakeClient(['/api/contacts']), dir, () => {});

    expect(await readJson(dir, 'contacts.json')).toBeNull();
    expect(await readJson(dir, 'statements.json')).toBeNull();
  });

  it('keeps writing the rest of the export after a failure', async () => {
    const lines: string[] = [];
    const dir = await mkdtemp(join(tmpdir(), 'domexa-export-'));
    await runExport(fakeClient(['/api/buildings/b7/units']), dir, (l) => lines.push(l));

    expect(await readJson(dir, 'organization.json')).toEqual({ id: 1, name: 'Test kompanija' });
    expect(await readJson(dir, 'statements.json')).toEqual({ c1: { closingBalance: '1234.56' } });
    expect(lines).toContain('skipped /api/buildings/b7/units: Domexa answered 0 on /api/buildings/b7/units');
    expect(lines).toContain('wrote units.json');
  });
});
