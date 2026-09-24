const LOGIN_PATH = '/api/auth/login';

export class DomexaHttpError extends Error {
  constructor(readonly status: number, readonly path: string, readonly body: string) {
    super(`Domexa answered ${status} on ${path}`);
    this.name = 'DomexaHttpError';
  }
}

/**
 * The migration never writes to Domexa (spec §20.2/§20.4). Every request goes through one private
 * `send`, and this is the only place a non-GET is allowed — the login, by its literal path.
 */
export function assertReadOnly(method: string, path: string): void {
  if (method === 'GET') return;
  if (method === 'POST' && path === LOGIN_PATH) return;
  throw new Error(`the Domexa client is read-only: refusing ${method} ${path}`);
}

export interface DomexaClientOptions {
  baseUrl: string;
  org: string;
  email?: string;
  password?: string;
  /** A session cookie captured from a logged-in browser, for when Turnstile blocks the API login. */
  cookie?: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  pageSize?: number;
}

interface DomexaPage { rows?: unknown[]; total?: number; page?: number; pageSize?: number }

export class DomexaClient {
  private cookie: string;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;
  private readonly pageSize: number;

  constructor(private readonly o: DomexaClientOptions) {
    this.cookie = o.cookie ?? '';
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.log = o.log ?? ((l) => console.log(l));
    this.pageSize = o.pageSize ?? 200;
  }

  async login(): Promise<void> {
    if (this.cookie) { this.log('using the captured DOMEXA_COOKIE, no login call'); return; }
    if (!this.o.email || !this.o.password) throw new Error('set DOMEXA_EMAIL and DOMEXA_PASSWORD, or capture a session into DOMEXA_COOKIE');
    const res = await this.send('POST', LOGIN_PATH, { tenantSlug: this.o.org, email: this.o.email, password: this.o.password });
    const set = res.headers.getSetCookie?.() ?? [];
    this.cookie = (set[0] ?? res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    if (!this.cookie) throw new Error('the Domexa login returned no cookie — capture one in a browser and set DOMEXA_COOKIE');
  }

  async get<T>(path: string): Promise<T> {
    return (await (await this.send('GET', path)).json()) as T;
  }

  /** Walks `{ rows, total, page, pageSize }` until `total` rows are in hand. A bare array ends it. */
  async getAll(path: string): Promise<unknown[]> {
    const rows: unknown[] = [];
    for (let page = 1; page <= 1000; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const body = await this.get<DomexaPage | unknown[]>(`${path}${sep}page=${page}&pageSize=${this.pageSize}`);
      if (Array.isArray(body)) return body;
      const batch = Array.isArray(body.rows) ? body.rows : [];
      rows.push(...batch);
      const total = typeof body.total === 'number' ? body.total : rows.length;
      if (batch.length === 0 || rows.length >= total) break;
    }
    return rows;
  }

  private async send(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    assertReadOnly(method, path);
    this.log(`${method} ${path}`); // method and path only — never a body, a cookie or a password
    const res = await this.fetchImpl(`${this.o.baseUrl}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new DomexaHttpError(res.status, path, (await res.text()).slice(0, 300));
    return res;
  }
}
