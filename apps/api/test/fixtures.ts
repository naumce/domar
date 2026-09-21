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
