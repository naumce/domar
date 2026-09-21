import { ref } from 'vue';
import { api, ApiError } from '@/api/client';

type Query = Record<string, string | number | boolean | undefined>;

export function useResource<T extends { id: string }>(path: string) {
  const rows = ref<T[]>([]) as import('vue').Ref<T[]>;
  const total = ref(0);
  const loading = ref(false);
  const error = ref<string | null>(null);
  let lastQuery: Query | undefined;

  async function load(query?: Query) {
    loading.value = true; error.value = null; lastQuery = query;
    try {
      const res = await api.get<{ rows: T[]; total?: number }>(path, query);
      rows.value = res.rows; total.value = res.total ?? res.rows.length;
    } catch (e) { error.value = e instanceof ApiError ? e.code : 'error'; throw e; } finally { loading.value = false; }
  }
  async function wrap<R>(fn: () => Promise<R>): Promise<R> {
    error.value = null;
    try { const r = await fn(); await load(lastQuery); return r; } catch (e) { error.value = e instanceof ApiError ? e.code : 'error'; throw e; }
  }
  const create = (body: unknown) => wrap(() => api.post<T>(path, body));
  const update = (id: string, patch: unknown) => wrap(() => api.patch<T>(`${path}/${id}`, patch));
  const remove = (id: string) => wrap(() => api.del(`${path}/${id}`));
  return { rows, total, loading, error, load, create, update, remove };
}
