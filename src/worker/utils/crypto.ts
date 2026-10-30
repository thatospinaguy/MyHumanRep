/**
 * Cryptographic helpers built only on the Web Crypto API. No custom primitives.
 */

const encoder = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export type IdPrefix = 'conv' | 'msg' | 'cap' | 'evt' | 'aud' | 'abuse' | 'req' | 'sr' | 'acct' | 'per' | 'prev' | 'emb' | 'pinq' | 'cand' | 'capdef';

/** Opaque, non-sequential public identifier with 128 bits of randomness. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${base64url(randomBytes(16))}`;
}

export const TOKEN_PREFIX = 'mhr_';
/** 32 random bytes => 43 base64url characters => 256 bits of entropy. */
export const TOKEN_PATTERN = /^mhr_[A-Za-z0-9_-]{43}$/;

export function newConversationToken(): string {
  return `${TOKEN_PREFIX}${base64url(randomBytes(32))}`;
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function importHmacKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ]);
    keyCache.set(secret, key);
  }
  return key;
}

/** HMAC-SHA-256 with domain separation by purpose, hex encoded. */
export async function hmacHex(secret: string, purpose: string, value: string): Promise<string> {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${purpose}\u0000${value}`));
  return toHex(sig);
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

/** Constant-time string comparison for equal-length secrets/digests. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  // Compare against self when lengths differ so timing does not reveal length match.
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (x: ArrayBufferView, y: ArrayBufferView) => boolean;
  };
  if (ab.length !== bb.length) {
    if (subtle.timingSafeEqual) subtle.timingSafeEqual(ab, ab);
    return false;
  }
  if (subtle.timingSafeEqual) return subtle.timingSafeEqual(ab, bb);
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}

/** Deterministic JSON with sorted keys, used for payload hashing. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
