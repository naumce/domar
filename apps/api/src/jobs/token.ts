import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { Config } from '../config.js';
import { AppError, forbidden, unauthorized } from '../errors.js';

/**
 * The cron's whole authentication (spec §18.3). The header is checked first, so an unauthenticated
 * caller learns nothing about this server's configuration and a misconfigured server still answers
 * a token-less probe with 401.
 */
export function assertJobToken(config: Config, headers: IncomingHttpHeaders): void {
  const given = headers['x-job-token'];
  if (typeof given !== 'string' || given.length === 0) throw unauthorized();
  const expected = config.jobToken;
  if (!expected) throw new AppError(503, 'job_token_not_configured', 'JOB_TOKEN is not configured on this server');
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw forbidden();
}
