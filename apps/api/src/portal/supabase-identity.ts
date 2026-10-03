import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Config } from '../config.js';

/** The one external provider the bridge knows; stored in `owner_account_identities.provider`. */
export const SUPABASE_PROVIDER = 'supabase';

/** Every Supabase access token carries this audience; a service-role or anon key does not. */
const SUPABASE_AUDIENCE = 'authenticated';

/**
 * Asymmetric only. The project signs with ES256 today and may rotate to RS256; HS256 is deliberately
 * absent, because a shared secret is not what a JWKS hands out and accepting it would turn a leaked
 * anon key into a login.
 */
const ALGORITHMS = ['ES256', 'RS256'];

export interface SupabaseIdentity {
  /** False when `SUPABASE_JWKS_URL` is unset: the bridge is off and every bearer token is ignored. */
  readonly configured: boolean;
  /**
   * The verified `sub` of an `Authorization: Bearer <jwt>` header, or null. Null is the only failure
   * mode there is — a token that fails the signature, the issuer, the audience or the expiry yields
   * no identity at all, never a partially trusted one.
   */
  subject(authorization: string | undefined): Promise<string | null>;
}

function bearer(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const [scheme, token, ...rest] = authorization.split(' ');
  if (rest.length > 0 || !token || scheme?.toLowerCase() !== 'bearer') return null;
  return token;
}

/**
 * Verifies domko's Supabase tokens, mirroring `createMailer` and `createPusher`: without
 * configuration this is an explicit no-op rather than a boot-time throw, so an API with no bridge
 * simply never sees an identity.
 *
 * `createRemoteJWKSet` keeps the fetched keys in memory and only re-fetches on an unknown `kid`
 * (with its own cooldown), so verification costs one signature check per request, not one HTTP call.
 */
export function createSupabaseIdentity(config: Config): SupabaseIdentity {
  if (!config.supabaseJwksUrl) {
    return { configured: false, async subject() { return null; } };
  }
  const jwks = createRemoteJWKSet(new URL(config.supabaseJwksUrl));
  return {
    configured: true,
    async subject(authorization) {
      const token = bearer(authorization);
      if (!token) return null;
      try {
        const { payload } = await jwtVerify(token, jwks, {
          audience: SUPABASE_AUDIENCE,
          algorithms: ALGORITHMS,
          // A token without `exp` would otherwise verify forever; Supabase always sets one.
          requiredClaims: ['exp'],
          ...(config.supabaseIssuer ? { issuer: config.supabaseIssuer } : {}),
        });
        return typeof payload.sub === 'string' && payload.sub.length > 0 ? payload.sub : null;
      } catch {
        // Signature, issuer, audience, expiry, an unreachable JWKS: all the same answer.
        return null;
      }
    },
  };
}
