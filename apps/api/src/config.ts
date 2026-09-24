import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  API_PORT: z.coerce.number().int().positive().default(3001),
  API_HOST: z.string().default('127.0.0.1'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  TRUST_PROXY: z.string().default('false'),
  PDF_BROWSER_CHANNEL: z.string().default('chrome'),
  SERVE_WEB: z.enum(['true', 'false']).default('false'),
  WEB_DIST: z.string().default(''),
});

export interface Config {
  databaseUrl: string;
  port: number;
  host: string;
  corsOrigins: string[];
  isProduction: boolean;
  env: 'development' | 'test' | 'production';
  trustProxy: boolean | string | number;
  pdfBrowserChannel: string;
  serveWeb: boolean;
  webDist: string;
}

/** apps/web/dist, resolved from apps/api/src/config.ts, so it works in the repo and in the image. */
const DEFAULT_WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));

function parseTrustProxy(value: string): boolean | string | number {
  if (value === 'false') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env);
  return {
    databaseUrl: parsed.DATABASE_URL,
    port: parsed.API_PORT,
    host: parsed.API_HOST,
    corsOrigins: parsed.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    isProduction: parsed.NODE_ENV === 'production',
    env: parsed.NODE_ENV,
    trustProxy: parseTrustProxy(parsed.TRUST_PROXY),
    pdfBrowserChannel: parsed.PDF_BROWSER_CHANNEL,
    serveWeb: parsed.SERVE_WEB === 'true',
    webDist: parsed.WEB_DIST || DEFAULT_WEB_DIST,
  };
}
