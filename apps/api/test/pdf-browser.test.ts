import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('playwright-core', () => {
  const launch = vi.fn(async () => ({ isConnected: () => true, newContext: async () => ({ newPage: async () => ({ setContent: async () => {}, pdf: async () => Buffer.from('%PDF') }), close: async () => {} }), close: async () => {} }));
  return { chromium: { launch } };
});

describe('pdf browser singleton', () => {
  afterEach(async () => { const m = await import('../src/pdf/html-to-pdf.js'); await m.closePdfBrowser(); m._resetForTests(); });
  it('launches Chrome once for concurrent cold starts', async () => {
    const { htmlToPdf } = await import('../src/pdf/html-to-pdf.js');
    const { chromium } = await import('playwright-core');
    const results = await Promise.all([htmlToPdf('<p>a</p>', 'chrome'), htmlToPdf('<p>b</p>', 'chrome'), htmlToPdf('<p>c</p>', 'chrome')]);
    expect(results.every((b) => b.toString().startsWith('%PDF'))).toBe(true);
    expect((chromium.launch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
  });
});
