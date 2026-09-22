import { type Browser, chromium } from 'playwright-core';

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;
const MAX_CONCURRENT_RENDERS = 2;
let running = 0;
const waiting: (() => void)[] = [];

/** Memoizes the in-flight launch: concurrent cold starts share one Chrome instead of racing separate launches. */
async function getBrowser(channel: string): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  if (!launching) {
    launching = chromium.launch({ channel, headless: true }).then((b) => { browser = b; return b; }).finally(() => { launching = null; });
  }
  return launching;
}

/** Tiny in-process semaphore: Chrome is happy with a couple of pages at a time, not with dozens. */
async function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT_RENDERS) { running += 1; return; }
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  if (next) next(); // hand the slot straight to the next waiter
  else running -= 1;
}

export async function htmlToPdf(html: string, channel: string): Promise<Buffer> {
  await acquire();
  try {
    const context = await (await getBrowser(channel)).newContext();
    try {
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      return await page.pdf({ format: 'A4', printBackground: true, margin: { top: '15mm', right: '15mm', bottom: '15mm', left: '15mm' } });
    } finally {
      await context.close();
    }
  } finally {
    release();
  }
}

export async function closePdfBrowser(): Promise<void> {
  const b = browser;
  browser = null;
  if (b) await b.close();
}

export function _resetForTests(): void {
  browser = null;
  launching = null;
  running = 0;
  waiting.length = 0;
}
