import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createMailer } from '../src/email/mailer.js';
import { registerTenant } from './fixtures.js';
import { createTestApp } from './helpers.js';

const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/d', NODE_ENV: 'test' } as Record<string, string>;

describe('config', () => {
  it('defaults the email settings and leaves SMTP unset', () => {
    const c = loadConfig(base);
    expect(c.smtpUrl).toBe('');
    expect(c.emailFrom).toBe('domar <no-reply@localhost>');
    expect(c.jobToken).toBe('');
  });

  it('requires JOB_TOKEN in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/JOB_TOKEN/);
    expect(loadConfig({ ...base, NODE_ENV: 'production', JOB_TOKEN: 'secret' }).jobToken).toBe('secret');
  });
});

describe('mailer', () => {
  it('is an explicit no-op without SMTP_URL', async () => {
    const m = createMailer(loadConfig(base));
    expect(m.configured).toBe(false);
    expect(await m.send({ to: 'a@b.mk', subject: 's', text: 't' })).toEqual({ error: 'smtp_not_configured' });
    expect(m.outbox).toEqual([]);
    await m.close();
  });

  it('captures messages with the json transport', async () => {
    const m = createMailer(loadConfig({ ...base, SMTP_URL: 'json', EMAIL_FROM: 'domar <x@y.mk>' }));
    expect(m.configured).toBe(true);
    const res = await m.send({ to: 'a@b.mk', subject: 'Опомена', text: 'долг', attachments: [{ filename: 'o.pdf', content: Buffer.from('%PDF'), contentType: 'application/pdf' }] });
    expect('id' in res).toBe(true);
    expect(m.outbox).toHaveLength(1);
    expect(m.outbox[0]!.to).toBe('a@b.mk');
    expect(m.outbox[0]!.attachments![0]!.filename).toBe('o.pdf');
    await m.close();
  });
});

describe('tenant email status', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let a: Awaited<ReturnType<typeof registerTenant>>;
  beforeAll(async () => { t = await createTestApp({ SMTP_URL: 'json' }); a = await registerTenant(t.app, 'firma-mail'); });
  afterAll(async () => { await t.close(); });

  it('reports emailConfigured on GET /api/tenant', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/tenant', headers: { cookie: a.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().emailConfigured).toBe(true);
    expect(t.app.mailer.configured).toBe(true);
  });
});
