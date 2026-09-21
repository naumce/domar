import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '@/api/client';

describe('api client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends credentials and JSON, returns parsed body', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await api.post<{ ok: number }>('/api/x', { a: 1 });
    expect(res).toEqual({ ok: 1 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:3001/api/x');
    expect(init.credentials).toBe('include');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
  });

  it('throws ApiError with envelope fields on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'invalid_credentials', message: 'Nope' } }), { status: 401, headers: { 'content-type': 'application/json' } })));
    await expect(api.get('/api/auth/me')).rejects.toMatchObject({ status: 401, code: 'invalid_credentials', message: 'Nope' });
    await expect(api.get('/api/auth/me')).rejects.toBeInstanceOf(ApiError);
  });

  it('serializes query params and returns undefined for 204', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await api.get('/api/list', { search: 'а б', page: 2, skip: undefined });
    expect(res).toBeUndefined();
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('http://localhost:3001/api/list?search=%D0%B0+%D0%B1&page=2');
  });
});
