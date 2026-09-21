import { createDb } from '@domar/db';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const { db, sql } = createDb(config.databaseUrl);
const app = await buildApp({ db, sql, config });
await app.listen({ port: config.port, host: config.host });
