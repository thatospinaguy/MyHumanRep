import type { z } from 'zod';
import type { Config } from '../config';
import type { Env } from '../env';
import { hmacHex } from '../utils/crypto';
import { ApiError } from '../utils/http-errors';
import type { Mailer } from './notifications';

export type Interface = 'rest' | 'mcp';

/** Per-request dependencies shared by REST and MCP handlers. */
export interface ServiceContext {
  env: Env;
  config: Config;
  db: D1Database;
  now: Date;
  requestId: string;
  via: Interface;
  /** Keyed, day-scoped digest of the approximate client source. Never a raw IP. */
  sourceDigest: string;
  hmacKey: string;
  waitUntil: (promise: Promise<unknown>) => void;
  mailer: Mailer;
}

export function requireHmacKey(env: Env): string {
  const key = env.CONVERSATION_TOKEN_HMAC_KEY;
  if (!key || key.length < 32) {
    // Fail closed: without the key no credential can be issued or checked.
    throw new ApiError('unavailable', 'The service is not fully configured. Try again later.', {
      reason: 'service_not_configured',
    });
  }
  return key;
}

export async function sourceDigestFor(request: Request, hmacKey: string, now: Date): Promise<string> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const day = now.toISOString().slice(0, 10);
  return (await hmacHex(hmacKey, 'source', `${day}|${ip}`)).slice(0, 32);
}

/** Validate with Zod and convert failures into a sanitized, machine-readable 400. */
export function parseInput<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const issues = result.error.issues.slice(0, 20).map((issue) => {
    const path = issue.path
      .map((p) => (typeof p === 'number' ? String(p) : /^[A-Za-z0-9_]{1,64}$/.test(String(p)) ? String(p) : '<field>'))
      .join('.');
    let message = issue.message;
    if (issue.code === 'unrecognized_keys') {
      const keys = (issue as { keys?: string[] }).keys ?? [];
      const safe = keys.slice(0, 10).map((k) => (/^[A-Za-z0-9_]{1,64}$/.test(k) ? k : '<field>'));
      message = `Unknown field(s): ${safe.join(', ')}. Remove them; only documented fields are accepted.`;
    }
    return { path: path || '(body)', message: message.slice(0, 300) };
  });
  throw new ApiError('invalid_request', 'The request did not pass validation. See details.issues.', {
    reason: 'validation_failed',
    issues,
  });
}

/** Convert explicit nulls to undefined for optional fields. */
export function nn<T>(value: T | null | undefined): T | undefined {
  return value === null ? undefined : value;
}
