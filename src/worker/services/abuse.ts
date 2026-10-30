import { newId } from '../utils/crypto';
import { errors } from '../utils/http-errors';
import { DAY, iso, windowStart } from '../utils/time';
import type { ServiceContext } from './context';

export type AbuseCategory =
  | 'rate_limited_first_contact'
  | 'rate_limited_global'
  | 'rate_limited_thread'
  | 'rate_limited_mcp'
  | 'rate_limited_edge'
  | 'auth_failure'
  | 'auth_lockout'
  | 'intake_paused'
  | 'blocked_thread_write'
  | 'rejected_invalid'
  | 'duplicate_first_contact';

/**
 * Record a short-lived, non-identifying abuse signal. Best effort; never blocks the response.
 * `expires_at` is a default hint only: the retention job deletes by `created_at` using the
 * owner's current `abuse_retention_days` setting.
 */
export function recordAbuse(ctx: ServiceContext, category: AbuseCategory, retentionDays = 7): void {
  const stmt = ctx.db
    .prepare(
      'INSERT INTO abuse_events (id, event_category, request_id, correlation_digest, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
    )
    .bind(
      newId('abuse'),
      category,
      ctx.requestId,
      ctx.sourceDigest.slice(0, 16),
      iso(ctx.now),
      iso(new Date(ctx.now.getTime() + retentionDays * DAY)),
    );
  ctx.waitUntil(stmt.run().catch(() => undefined));
}

export interface ConsumeResult {
  allowed: boolean;
  count: number;
  retryAfterSeconds: number;
}

/**
 * Atomic fixed-window counter in D1 (single upsert statement). This is the
 * application-layer quota; the optional Workers Rate Limiting binding adds a
 * coarser edge layer in front of it.
 */
export async function consumeQuota(
  db: D1Database,
  key: string,
  windowMs: number,
  limit: number,
  now: Date,
  amount = 1,
): Promise<ConsumeResult> {
  const start = windowStart(now, windowMs);
  const end = start + windowMs;
  const row = await db
    .prepare(
      `INSERT INTO rate_limit_counters (bucket_key, count, expires_at) VALUES (?1, ?3, ?2)
       ON CONFLICT(bucket_key) DO UPDATE SET count = count + ?3
       RETURNING count`,
    )
    .bind(`${key}:${start}`, iso(new Date(end)), amount)
    .first<{ count: number }>();
  const count = row?.count ?? amount;
  return {
    allowed: count <= limit,
    count,
    retryAfterSeconds: Math.max(1, Math.ceil((end - now.getTime()) / 1000)),
  };
}

export async function peekQuota(db: D1Database, key: string, windowMs: number, now: Date): Promise<number> {
  const start = windowStart(now, windowMs);
  const row = await db
    .prepare('SELECT count FROM rate_limit_counters WHERE bucket_key = ?1')
    .bind(`${key}:${start}`)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function enforceQuota(
  ctx: ServiceContext,
  key: string,
  windowMs: number,
  limit: number,
  category: AbuseCategory,
): Promise<void> {
  const result = await consumeQuota(ctx.db, key, windowMs, limit, ctx.now);
  if (!result.allowed) {
    // Only record the first overflow per window to keep the table small under floods.
    if (result.count === limit + 1) recordAbuse(ctx, category);
    throw errors.rateLimited(result.retryAfterSeconds);
  }
}

/** Optional edge limiter (Workers Rate Limiting binding). Absent binding = no-op. */
export async function enforceEdgeLimit(ctx: ServiceContext, scope: string): Promise<void> {
  const limiter = ctx.env.RL_PUBLIC;
  if (!limiter) return;
  const { success } = await limiter.limit({ key: `${scope}:${ctx.sourceDigest}` });
  if (!success) {
    recordAbuse(ctx, 'rate_limited_edge');
    throw errors.rateLimited(60);
  }
}

const AUTH_WINDOW_MS = 10 * 60 * 1000;

export async function assertNotLockedOut(ctx: ServiceContext): Promise<void> {
  const count = await peekQuota(ctx.db, `authfail:${ctx.sourceDigest}`, AUTH_WINDOW_MS, ctx.now);
  if (count >= ctx.config.limits.authFailuresPerSourcePer10Min) {
    recordAbuse(ctx, 'auth_lockout');
    const start = windowStart(ctx.now, AUTH_WINDOW_MS);
    throw errors.rateLimited(Math.max(1, Math.ceil((start + AUTH_WINDOW_MS - ctx.now.getTime()) / 1000)));
  }
}

export async function recordAuthFailure(ctx: ServiceContext): Promise<void> {
  await consumeQuota(ctx.db, `authfail:${ctx.sourceDigest}`, AUTH_WINDOW_MS, Number.MAX_SAFE_INTEGER, ctx.now);
  recordAbuse(ctx, 'auth_failure');
}
