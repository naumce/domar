import { afterEach, describe, expect, it, vi } from 'vitest';
import { swallow, useResource } from '@/composables/useResource';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

describe('useResource', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('loads rows and total, then refreshes after create', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ rows: [{ id: '1' }], total: 1 }))
      .mockResolvedValueOnce(json({ id: '2' }, 201))
      .mockResolvedValueOnce(json({ rows: [{ id: '1' }, { id: '2' }], total: 2 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = useResource<{ id: string }>('/api/contacts');
    await r.load();
    expect(r.rows.value).toHaveLength(1);
    expect(r.total.value).toBe(1);
    await r.create({ lastName: 'x' });
    expect(r.rows.value).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('captures error code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: { code: 'label_taken', message: 'dup' } }, 409)));
    const r = useResource('/api/x');
    await expect(r.create({})).rejects.toMatchObject({ code: 'label_taken' });
    expect(r.error.value).toBe('label_taken');
  });
  it('swallow catches a rejected promise without an unhandled rejection', async () => {
    await expect(Promise.resolve(swallow(Promise.reject(new Error('x'))))).resolves.toBeUndefined();
  });
});
