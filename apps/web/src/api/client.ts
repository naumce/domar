export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * The production bundle is served by the API itself, so an unset VITE_API_URL means "same origin".
 * Vite replaces `import.meta.env.DEV` with a literal, so the dev URL is folded out of that build and
 * the deployed shell never carries it.
 */
export const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)
  ?? (import.meta.env.DEV ? 'http://localhost:3001' : window.location.origin);
type Query = Record<string, string | number | boolean | undefined>;

function url(path: string, query?: Query): string {
  const u = new URL(path, API_BASE);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v));
  return u.toString();
}

async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  const init: RequestInit = { method, credentials: 'include' };
  if (body instanceof FormData) {
    // No content-type: the browser must set multipart/form-data with its own boundary.
    init.body = body;
  } else if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url(path, query), init);
  if (res.status === 204) return undefined as T;
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json() : undefined;
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? res.statusText, e?.details);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>('GET', path, undefined, query),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: (path: string) => request<void>('DELETE', path),
  upload: <T>(path: string, form: FormData) => request<T>('POST', path, form),
};
