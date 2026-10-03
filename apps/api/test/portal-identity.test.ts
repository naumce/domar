import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { schema } from '@domar/db';
import { eq } from 'drizzle-orm';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

const ISSUER = 'https://test-project.supabase.co/auth/v1';
const KID = 'test-key-1';

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
interface Signer { privateKey: PrivateKey; jwk: JWK }

/** A throwaway ES256 pair, exactly the shape Supabase signs with. Nothing here reaches the network. */
async function makeSigner(kid: string): Promise<Signer> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' };
  return { privateKey, jwk };
}

describe('portal identity bridge', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  /** A second app with no SUPABASE_JWKS_URL: the bridge must simply be off there. */
  let off: Awaited<ReturnType<typeof createTestApp>>;
  let jwksServer: Server;
  let signer: Signer;
  /** Same `kid`, different key: the JWKS answer is found and the signature still has to fail. */
  let impostor: Signer;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  let b: Awaited<ReturnType<typeof registerTenant>>;
  let markoA = '';
  let anaA = '';
  let markoB = '';

  const SUB = '11111111-1111-4111-8111-111111111111';
  const OTHER_SUB = '22222222-2222-4222-8222-222222222222';

  const sign = async (over: {
    sub?: string; issuer?: string; audience?: string; expiresAt?: number; key?: Signer;
  } = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: KID })
      .setSubject(over.sub ?? SUB)
      .setIssuer(over.issuer ?? ISSUER)
      .setAudience(over.audience ?? 'authenticated')
      .setIssuedAt(now - 60)
      .setExpirationTime(over.expiresAt ?? now + 3600)
      .sign((over.key ?? signer).privateKey);
  };

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const staffPost = (url: string, payload: Record<string, unknown> = {}, cookie?: string) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: cookie ?? a.cookie }, payload });
  const codeFor = async (contactId: string, cookie?: string) =>
    (await staffPost(`/api/contacts/${contactId}/portal-invite`, {}, cookie)).json().code as string;
  const redeem = (token: string, code: string) =>
    t.app.inject({ method: 'POST', url: '/api/portal/identity/redeem', headers: bearer(token), payload: { code } });
  const me = (token: string) => t.app.inject({ method: 'GET', url: '/api/portal/me', headers: bearer(token) });

  beforeAll(async () => {
    signer = await makeSigner(KID);
    impostor = await makeSigner(KID);
    jwksServer = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [signer.jwk] }));
    });
    await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
    const { port } = jwksServer.address() as AddressInfo;

    t = await createTestApp({ SMTP_URL: 'json', SUPABASE_JWKS_URL: `http://127.0.0.1:${port}/jwks`, SUPABASE_ISSUER: ISSUER });
    off = await createTestApp({ SMTP_URL: 'json' });
    a = await registerTenant(t.app, 'firma-ida');
    b = await registerTenant(t.app, 'firma-idb');
    markoA = (await staffPost('/api/contacts', { firstName: 'Марко', lastName: 'Марков' })).json().id;
    anaA = (await staffPost('/api/contacts', { firstName: 'Ана', lastName: 'Анева' })).json().id;
    markoB = (await staffPost('/api/contacts', { firstName: 'Борис', lastName: 'Борисов' }, b.cookie)).json().id;
  });

  afterAll(async () => {
    await t.close();
    await off.close();
    await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
  });

  it('redeeming a code with a bearer token creates a passwordless, identity-backed account', async () => {
    const res = await redeem(await sign(), await codeFor(markoA));
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.links).toHaveLength(1);
    expect(body.links[0]).toMatchObject({ tenantId: a.tenantId, contactId: markoA, contactName: 'Марко Марков' });

    const accounts = await t.db.select().from(schema.ownerAccounts);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.passwordHash).toBeNull();
    const ids = await t.db.select().from(schema.ownerAccountIdentities);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatchObject({ provider: 'supabase', subject: SUB, ownerAccountId: accounts[0]!.id });

    const audit = await t.db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'portal_link.create'));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.tenantId).toBe(a.tenantId);
    expect(audit[0]!.userId).toBeNull();
  });

  it('a valid token for a linked subject reaches the portal', async () => {
    const token = await sign();
    const res = await me(token);
    expect(res.statusCode).toBe(200);
    expect(res.json().links).toHaveLength(1);
    const invoices = await t.app.inject({ method: 'GET', url: `/api/portal/invoices?contactId=${markoA}`, headers: bearer(token) });
    expect(invoices.statusCode).toBe(200);
  });

  it('a second code links another contact to the same account', async () => {
    const res = await redeem(await sign(), await codeFor(anaA));
    expect(res.statusCode).toBe(201);
    expect(res.json().links).toHaveLength(2);
    expect(await t.db.select().from(schema.ownerAccounts)).toHaveLength(1);
    expect(await t.db.select().from(schema.ownerAccountIdentities)).toHaveLength(1);
  });

  it('a code is spent exactly once', async () => {
    const code = await codeFor(markoB, b.cookie);
    expect((await redeem(await sign(), code)).statusCode).toBe(201);
    const again = await redeem(await sign({ sub: OTHER_SUB }), code);
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe('invalid_code');
    expect(await t.db.select().from(schema.ownerAccounts)).toHaveLength(1);
  });

  it('a contact of a tenant the caller has no link in is a 404, not a 403', async () => {
    const token = await sign({ sub: OTHER_SUB });
    expect((await redeem(token, await codeFor((await staffPost('/api/contacts', { firstName: 'Не', lastName: 'Знам' })).json().id))).statusCode).toBe(201);
    // Another account in the same tenant, and a contact in a tenant this caller has no link in.
    expect((await t.app.inject({ method: 'GET', url: `/api/portal/invoices?contactId=${markoA}`, headers: bearer(token) })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: `/api/portal/invoices?contactId=${markoB}`, headers: bearer(token) })).statusCode).toBe(404);
  });

  it('an unknown subject carries a valid token and still reaches nothing', async () => {
    const res = await me(await sign({ sub: '33333333-3333-4333-8333-333333333333' }));
    expect(res.statusCode).toBe(401);
  });

  it('rejects a wrong signature, a wrong issuer, a wrong audience and an expired token', async () => {
    expect((await me(await sign({ key: impostor }))).statusCode).toBe(401);
    expect((await me(await sign({ issuer: 'https://evil.supabase.co/auth/v1' }))).statusCode).toBe(401);
    expect((await me(await sign({ audience: 'anon' }))).statusCode).toBe(401);
    expect((await me(await sign({ expiresAt: Math.floor(Date.now() / 1000) - 3600 }))).statusCode).toBe(401);
    expect((await me('not-a-jwt')).statusCode).toBe(401);
  });

  it('a token none of those checks rejects cannot redeem either', async () => {
    const res = await redeem(await sign({ issuer: 'https://evil.supabase.co/auth/v1' }), await codeFor(markoA));
    expect(res.statusCode).toBe(401);
  });

  it('an unconfigured bridge ignores bearer tokens entirely', async () => {
    const token = await sign();
    expect(off.app.supabaseIdentity.configured).toBe(false);
    expect((await off.app.inject({ method: 'GET', url: '/api/portal/me', headers: bearer(token) })).statusCode).toBe(401);
    const res = await off.app.inject({ method: 'POST', url: '/api/portal/identity/redeem', headers: bearer(token), payload: { code: 'ABCDEF' } });
    expect(res.statusCode).toBe(401);
  });

  it('the cookie path is untouched: a password account still registers, reads /me and changes its password', async () => {
    const contactId = (await staffPost('/api/contacts', { firstName: 'Кире', lastName: 'Кирев' })).json().id;
    const reg = await t.app.inject({
      method: 'POST', url: '/api/portal/register',
      payload: { code: await codeFor(contactId), email: 'kire@owner.mk', password: 'correct-horse-1' },
    });
    expect(reg.statusCode).toBe(201);
    const cookie = String(Array.isArray(reg.headers['set-cookie']) ? reg.headers['set-cookie']![0] : reg.headers['set-cookie']).split(';')[0]!;
    const mine = await t.app.inject({ method: 'GET', url: '/api/portal/me', headers: { cookie } });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().account.email).toBe('kire@owner.mk');
    const changed = await t.app.inject({
      method: 'POST', url: '/api/portal/change-password', headers: { cookie },
      payload: { currentPassword: 'correct-horse-1', newPassword: 'correct-horse-2' },
    });
    expect(changed.statusCode).toBe(204);
  });

  it('an identity-backed account has no password to change', async () => {
    const res = await t.app.inject({
      method: 'POST', url: '/api/portal/change-password', headers: bearer(await sign()),
      payload: { currentPassword: 'correct-horse-1', newPassword: 'correct-horse-2' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('a deactivated identity-backed account reaches nothing and cannot spend a code', async () => {
    const [account] = await t.db.select().from(schema.ownerAccountIdentities).where(eq(schema.ownerAccountIdentities.subject, SUB));
    await t.db.update(schema.ownerAccounts).set({ isActive: false }).where(eq(schema.ownerAccounts.id, account!.ownerAccountId));
    expect((await me(await sign())).statusCode).toBe(401);
    const code = await codeFor((await staffPost('/api/contacts', { firstName: 'Зоран', lastName: 'Зоранов' })).json().id);
    expect((await redeem(await sign(), code)).statusCode).toBe(401);
    // The code survived the rejection.
    expect((await redeem(await sign({ sub: OTHER_SUB }), code)).statusCode).toBe(201);
    await t.db.update(schema.ownerAccounts).set({ isActive: true }).where(eq(schema.ownerAccounts.id, account!.ownerAccountId));
  });
});
