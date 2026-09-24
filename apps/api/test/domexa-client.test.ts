import { describe, expect, it, vi } from 'vitest';
import { assertReadOnly, DomexaClient, DomexaHttpError } from '../scripts/domexa/client.js';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

/** Records every call and answers from a queue; `headers` keeps the last request's headers. */
function stub(responses: Response[]) {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string> });
    return responses.shift() ?? json({});
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('the Domexa client', () => {
  it('is read-only apart from the login call', () => {
    expect(() => assertReadOnly('GET', '/api/contacts')).not.toThrow();
    expect(() => assertReadOnly('POST', '/api/auth/login')).not.toThrow();
    expect(() => assertReadOnly('POST', '/api/contacts')).toThrow(/read-only/);
    expect(() => assertReadOnly('DELETE', '/api/contacts/1')).toThrow(/refusing DELETE/);
    expect(() => assertReadOnly('PUT', '/api/auth/login')).toThrow(/read-only/);
  });

  it('follows the { rows, total, page, pageSize } envelope and logs the method and the path only', async () => {
    const { calls, fetchImpl } = stub([
      json({ rows: [{ id: 'c1' }], total: 3, page: 1, pageSize: 1 }),
      json({ rows: [{ id: 'c2' }], total: 3, page: 2, pageSize: 1 }),
      json({ rows: [{ id: 'c3' }], total: 3, page: 3, pageSize: 1 }),
    ]);
    const lines: string[] = [];
    const client = new DomexaClient({ baseUrl: 'https://domexa.mk', org: 'naum', cookie: 'domexa_session=s3cret', fetchImpl, log: (l) => lines.push(l), pageSize: 1 });

    expect(await client.getAll('/api/contacts')).toEqual([{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }]);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET', 'GET']);
    expect(calls.map((c) => c.url)).toEqual([
      'https://domexa.mk/api/contacts?page=1&pageSize=1',
      'https://domexa.mk/api/contacts?page=2&pageSize=1',
      'https://domexa.mk/api/contacts?page=3&pageSize=1',
    ]);
    expect(lines).toEqual([
      'GET /api/contacts?page=1&pageSize=1',
      'GET /api/contacts?page=2&pageSize=1',
      'GET /api/contacts?page=3&pageSize=1',
    ]);
    expect(calls[0]!.headers.cookie).toBe('domexa_session=s3cret');
    expect(lines.join('\n')).not.toContain('s3cret');
  });

  it('stops on an empty page and passes a plain array straight through', async () => {
    const empty = stub([json({ rows: [], total: 10 })]);
    const a = new DomexaClient({ baseUrl: 'https://domexa.mk', org: 'naum', cookie: 'x=1', fetchImpl: empty.fetchImpl, log: () => {} });
    expect(await a.getAll('/api/services')).toEqual([]);
    expect(empty.calls).toHaveLength(1);

    const plain = stub([json([{ id: 't1' }])]);
    const b = new DomexaClient({ baseUrl: 'https://domexa.mk', org: 'naum', cookie: 'x=1', fetchImpl: plain.fetchImpl, log: () => {} });
    expect(await b.getAll('/api/tax-rates')).toEqual([{ id: 't1' }]);
    expect(plain.calls).toHaveLength(1);
  });

  it('throws a DomexaHttpError carrying the status and the path', async () => {
    const { fetchImpl } = stub([json({ error: 'nope' }, 403)]);
    const client = new DomexaClient({ baseUrl: 'https://domexa.mk', org: 'naum', cookie: 'x=1', fetchImpl, log: () => {} });
    const failed = client.get('/api/organization');
    await expect(failed).rejects.toBeInstanceOf(DomexaHttpError);
    await expect(failed).rejects.toThrow(/403 on \/api\/organization/);
  });

  it('logs in once when no cookie was given and sends the session cookie afterwards', async () => {
    const login = new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'domexa_session=zzz; Path=/; HttpOnly' } });
    const { calls, fetchImpl } = stub([login, json({ id: 1, name: 'Test kompanija' })]);
    const client = new DomexaClient({ baseUrl: 'https://domexa.mk', org: 'naum', email: 'a@b.mk', password: 'pw', fetchImpl, log: () => {} });

    await client.login();
    await client.get('/api/organization');
    expect(calls.map((c) => [c.url, c.method])).toEqual([
      ['https://domexa.mk/api/auth/login', 'POST'],
      ['https://domexa.mk/api/organization', 'GET'],
    ]);
    expect(calls[1]!.headers.cookie).toBe('domexa_session=zzz');
  });

  it('skips the login entirely when DOMEXA_COOKIE was supplied', async () => {
    const { calls, fetchImpl } = stub([]);
    const client = new DomexaClient({ baseUrl: 'https://domexa.mk', org: 'naum', cookie: 'domexa_session=captured', fetchImpl, log: () => {} });
    await client.login();
    expect(calls).toHaveLength(0);
  });

  it('refuses to guess credentials', async () => {
    const { fetchImpl } = stub([]);
    const client = new DomexaClient({ baseUrl: 'https://domexa.mk', org: 'naum', fetchImpl, log: () => {} });
    await expect(client.login()).rejects.toThrow(/DOMEXA_EMAIL/);
  });
});
