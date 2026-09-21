import { chromium } from 'playwright-core';

export async function htmlToPdf(html: string, channel: string): Promise<Buffer> {
  const browser = await chromium.launch({ channel, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    return await page.pdf({ format: 'A4', printBackground: true, margin: { top: '15mm', right: '15mm', bottom: '15mm', left: '15mm' } });
  } finally {
    await browser.close();
  }
}
