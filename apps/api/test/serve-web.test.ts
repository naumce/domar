import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers.js';

describe('SPA serving behind SERVE_WEB', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'domar-web-'));
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>domar</title><div id="app"></div>');
    await writeFile(join(dir, 'assets.txt'), 'asset');
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
    t = await createTestApp({ SERVE_WEB: 'true', WEB_DIST: dir });
  });
  afterAll(async () => { await t.close(); });

  it('serves index.html at the root', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<div id="app">');
  });

  it('falls back to index.html for a client route', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/app/buildings' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<div id="app">');
  });

  it('serves a static file from the dist directory', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/assets.txt' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('asset');
  });

  it('caches hashed assets forever and never caches the shell', async () => {
    const asset = await t.app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const shell = await t.app.inject({ method: 'GET', url: '/' });
    expect(shell.headers['cache-control']).toBe('no-cache');
  });

  it('404s a missing asset instead of serving the shell', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/assets/missing.js' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('keeps the JSON envelope for unknown API routes', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('still answers the health route as JSON', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
  });
});
