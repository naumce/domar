import type { FastifyInstance } from 'fastify';

export async function registerTenant(app: FastifyInstance, slug: string): Promise<{ cookie: string; tenantId: string; userId: string }> {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: { tenant: { slug, name: `Firma ${slug}`, countryCode: 'mk' }, user: { email: `owner@${slug}.mk`, password: 'correct-horse-1', firstName: 'O', lastName: slug } },
  });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.body}`);
  const raw = res.headers['set-cookie'];
  const cookie = String(Array.isArray(raw) ? raw[0] : raw).split(';')[0]!;
  const body = res.json();
  return { cookie, tenantId: body.tenant.id, userId: body.user.id };
}

/** A second staff login in the same tenant: created by the owner, then signed in with its temporary password. */
export async function createStaffUser(
  app: FastifyInstance,
  ownerCookie: string,
  slug: string,
  input: { email: string; firstName: string; lastName: string; role: 'owner' | 'accountant' | 'technician' | 'readonly' },
): Promise<{ id: string; cookie: string }> {
  const created = await app.inject({ method: 'POST', url: '/api/users', headers: { cookie: ownerCookie }, payload: input });
  if (created.statusCode !== 201) throw new Error(`user create failed: ${created.body}`);
  const { user, temporaryPassword } = created.json();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantSlug: slug, email: input.email, password: temporaryPassword } });
  if (login.statusCode !== 200) throw new Error(`login failed: ${login.body}`);
  const raw = login.headers['set-cookie'];
  return { id: user.id, cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0]! };
}
