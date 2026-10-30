import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Config } from '../config';
import { ApiError } from '../utils/http-errors';

export interface AdminIdentity {
  email: string;
  mode: 'access' | 'dev_insecure';
}

const jwksCache = new Map<string, JWTVerifyGetKey>();

export function remoteAccessKeys(teamDomain: string): JWTVerifyGetKey {
  let resolver = jwksCache.get(teamDomain);
  if (!resolver) {
    resolver = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`), {
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });
    jwksCache.set(teamDomain, resolver);
  }
  return resolver;
}

function isPlaceholder(value: string): boolean {
  return value === '' || value.includes('REPLACE');
}

function readAssertion(request: Request): string | null {
  const header = request.headers.get('cf-access-jwt-assertion');
  if (header) return header.trim();
  const cookie = request.headers.get('cookie') ?? '';
  const match = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  return match ? decodeURIComponent(match[1]!) : null;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Verifies the Cloudflare Access assertion (signature via team JWKS, issuer,
 * audience, expiry) and then applies an application-level email allowlist.
 * Every misconfiguration path denies access; nothing defaults to open.
 */
export async function authenticateAdmin(
  request: Request,
  config: Config,
  keyResolver?: JWTVerifyGetKey,
): Promise<AdminIdentity> {
  if (config.adminAuthMode === 'dev_insecure') {
    const host = new URL(request.url).hostname;
    if (config.environment === 'development' && LOCAL_HOSTS.has(host)) {
      return { email: config.adminEmails[0] ?? 'dev@localhost', mode: 'dev_insecure' };
    }
    throw new ApiError('forbidden', 'Admin access denied.', { reason: 'dev_auth_not_allowed_here' });
  }
  if (config.adminAuthMode !== 'access') {
    throw new ApiError('unavailable', 'Admin authentication is not configured.', { reason: 'admin_auth_misconfigured' });
  }
  if (isPlaceholder(config.accessTeamDomain) || isPlaceholder(config.accessAud) || !config.accessTeamDomain.startsWith('https://')) {
    throw new ApiError('unavailable', 'Admin authentication is not configured.', { reason: 'admin_auth_misconfigured' });
  }
  if (config.adminEmails.length === 0 || config.adminEmails.some(isPlaceholder)) {
    throw new ApiError('forbidden', 'Admin access denied.', { reason: 'no_admins_configured' });
  }

  const token = readAssertion(request);
  if (!token) throw new ApiError('unauthorized', 'Admin authentication required.', { reason: 'missing_access_assertion' });

  let email: unknown;
  try {
    const { payload } = await jwtVerify(token, keyResolver ?? remoteAccessKeys(config.accessTeamDomain), {
      issuer: config.accessTeamDomain,
      audience: config.accessAud,
      algorithms: ['RS256'],
      clockTolerance: 30,
      requiredClaims: ['exp', 'iat', 'sub'],
    });
    email = payload['email'];
  } catch (err) {
    const reason =
      err instanceof joseErrors.JWTExpired
        ? 'access_assertion_expired'
        : err instanceof joseErrors.JWTClaimValidationFailed
          ? 'access_assertion_claims_invalid'
          : 'access_assertion_invalid';
    throw new ApiError('unauthorized', 'Admin authentication failed.', { reason });
  }
  if (typeof email !== 'string' || !config.adminEmails.includes(email.toLowerCase())) {
    throw new ApiError('forbidden', 'Admin access denied.', { reason: 'not_an_admin' });
  }
  return { email: email.toLowerCase(), mode: 'access' };
}

/**
 * CSRF defense for cookie-authenticated admin writes: a custom header (forces a
 * CORS preflight that is never granted), plus Origin / Fetch-Metadata checks.
 */
export function assertSameOriginWrite(request: Request, config: Config): void {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') return;
  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  const okOrigin = origin === null || origin === requestOrigin || origin === config.baseOrigin;
  const okSite = fetchSite === null || fetchSite === 'same-origin';
  if (request.headers.get('x-mhr-admin') !== '1' || !okOrigin || !okSite) {
    throw new ApiError('forbidden', 'Cross-site or unmarked admin write rejected.', { reason: 'csrf_check_failed' });
  }
}
