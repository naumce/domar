import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { assertJobToken } from '../src/jobs/token.js';

const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/d', NODE_ENV: 'test' } as NodeJS.ProcessEnv;

/** Runs `assertJobToken` and returns the status it threw, or 200 if it did not throw. */
function statusOf(config: ReturnType<typeof loadConfig>, headers: Record<string, string>): number {
  try {
    assertJobToken(config, headers);
    return 200;
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    return err.statusCode;
  }
}

// The shared check behind both `/api/jobs/reminders` and `/api/jobs/notifications`. Both routes'
// own tests exercise it through HTTP with a configured JOB_TOKEN; this covers the unconfigured
// server directly, which docs/DEPLOY.md promises (twice) and nothing else asserts.
describe('assertJobToken', () => {
  it('answers 401 without a header, whether or not the server has a token configured', () => {
    expect(statusOf(loadConfig({ ...base, JOB_TOKEN: 'a-cron-secret-0123456789' }), {})).toBe(401);
    expect(statusOf(loadConfig(base), {})).toBe(401);
  });

  it('answers 503 when JOB_TOKEN is unset on the server, even with a token header present', () => {
    const config = loadConfig(base); // JOB_TOKEN defaults to ''
    expect(statusOf(config, { 'x-job-token': 'whatever' })).toBe(503);
  });

  it('answers 403 on a wrong token and passes a matching one', () => {
    const config = loadConfig({ ...base, JOB_TOKEN: 'a-cron-secret-0123456789' });
    expect(statusOf(config, { 'x-job-token': 'nope' })).toBe(403);
    expect(statusOf(config, { 'x-job-token': 'a-cron-secret-0123456789' })).toBe(200);
  });
});
