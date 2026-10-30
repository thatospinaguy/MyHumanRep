import type { Config } from '../config';

const PUBLIC_CSP = [
  "default-src 'none'",
  "style-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const ADMIN_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Applies restrictive security headers to every response. */
export function applySecurityHeaders(response: Response, path: string, config: Config): Response {
  const headers = new Headers(response.headers);
  const isAdmin = path === '/admin' || path.startsWith('/admin/');
  headers.set('Content-Security-Policy', isAdmin ? ADMIN_CSP : PUBLIC_CSP);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', isAdmin ? 'no-referrer' : 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  if (isAdmin) {
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Robots-Tag', 'noindex, nofollow');
  }
  if (config.hstsEnabled) headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
