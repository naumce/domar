import { createDb } from '@domar/db';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { closePdfBrowser } from './pdf/html-to-pdf.js';

const config = loadConfig();
const { db, sql } = createDb(config.databaseUrl);
const app = await buildApp({ db, sql, config });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void (async () => {
      await app.close();
      await closePdfBrowser();
      process.exit(0);
    })();
  });
}

await app.listen({ port: config.port, host: config.host });
