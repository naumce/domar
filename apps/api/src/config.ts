import { resolve } from 'node:path';
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
  DATA_DIR: z.string().default('./data'),
  SMTP_URL: z.string().default(''),
  EMAIL_FROM: z.string().default('domar <no-reply@localhost>'),
  JOB_TOKEN: z.string().default(''),
  // Web Push. All three optional: unset means "no push", exactly like an unset SMTP_URL means
  // "no email" — the app never crashes for lack of a key (spec §9, plan addendum 5).
  VAPID_PUBLIC_KEY: z.string().default(''),
  VAPID_PRIVATE_KEY: z.string().default(''),
  VAPID_SUBJECT: z.string().default(''),
  /** Per-IP ceiling on the auth routes each minute. Ten is right for a real deployment; a test
   * harness registering a tenant per spec from one address needs headroom. */
  AUTH_RATE_MAX: z.coerce.number().int().min(1).max(1000).default(10),
  /** Per-IP ceiling each minute on the accounting reads that derive up to a year of ledger in
   * memory. Ten is right for a deployment; a test file that makes eleven calls is not a rate-limit
   * bug, so the harness raises it rather than every test counting its own requests. */
  ACCOUNTING_RATE_MAX: z.coerce.number().int().min(1).max(1000).default(10),
  // The domko bridge. Both optional and both empty by default: an unset SUPABASE_JWKS_URL means
  // "no bridge", exactly like an unset SMTP_URL means "no email" — bearer tokens are then ignored
  // and nothing throws at boot. SUPABASE_ISSUER left empty skips the issuer check.
  SUPABASE_JWKS_URL: z.string().default(''),
  SUPABASE_ISSUER: z.string().default(''),
  // Empty means "unset", like SMTP_URL: .env.example ships the key blank and a blank must not crash.
  PUBLIC_WEB_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
}).superRefine((v, ctx) => {
  // Without it the reminder cron endpoint is permanently 503, i.e. reminders would silently stop.
  if (v.NODE_ENV === 'production' && !v.JOB_TOKEN) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['JOB_TOKEN'], message: 'JOB_TOKEN is required when NODE_ENV=production' });
  }
  // The job endpoint is reachable from the internet, so a short shared secret is worth guessing.
  if (v.JOB_TOKEN && v.JOB_TOKEN.length < 16) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['JOB_TOKEN'], message: 'JOB_TOKEN must be at least 16 characters' });
  }
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
  /** Root of the uploaded-document tree; outside the web root and never served statically. */
  dataDir: string;
  /** SMTP connection URL, `json` for the in-memory test transport, or '' for "email disabled". */
  smtpUrl: string;
  emailFrom: string;
  jobToken: string;
  /** VAPID application server key, handed to the browser so it can subscribe. '' = push disabled. */
  vapidPublicKey: string;
  /** The private half, `memory` for the in-memory test transport, or '' for "push disabled". */
  vapidPrivateKey: string;
  /** `mailto:` or `https:` contact the push service may use to reach the operator. */
  vapidSubject: string;
  authRateMax: number;
  accountingRateMax: number;
  /** Public origin of the web app, e.g. `https://domar.mk`; unset when nobody told the API its URL. */
  publicWebUrl: string | undefined;
  /** Supabase JWKS endpoint for the domko bridge. '' = the bridge is off and bearer tokens are ignored. */
  supabaseJwksUrl: string;
  /** Expected `iss` of a Supabase token, e.g. `https://<ref>.supabase.co/auth/v1`. '' = not checked. */
  supabaseIssuer: string;
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
    dataDir: resolve(parsed.DATA_DIR),
    smtpUrl: parsed.SMTP_URL,
    emailFrom: parsed.EMAIL_FROM,
    jobToken: parsed.JOB_TOKEN,
    vapidPublicKey: parsed.VAPID_PUBLIC_KEY,
    vapidPrivateKey: parsed.VAPID_PRIVATE_KEY,
    vapidSubject: parsed.VAPID_SUBJECT || 'mailto:no-reply@localhost',
    authRateMax: parsed.AUTH_RATE_MAX,
    accountingRateMax: parsed.ACCOUNTING_RATE_MAX,
    publicWebUrl: parsed.PUBLIC_WEB_URL?.replace(/\/$/, ''),
    supabaseJwksUrl: parsed.SUPABASE_JWKS_URL,
    supabaseIssuer: parsed.SUPABASE_ISSUER,
  };
}
