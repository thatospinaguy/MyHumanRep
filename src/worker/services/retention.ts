import type { Config } from '../config';
import { DAY, iso } from '../utils/time';
import { auditStatement } from './audit';
import { getSettings } from './settings';

export interface RetentionResult {
  conversations_deleted: number;
  abuse_events_deleted: number;
  rate_limit_counters_deleted: number;
  audit_events_deleted: number;
  outbox_rows_deleted: number;
}

/**
 * Daily retention job. Conversations are deleted (with cascading messages,
 * requests and outbox rows) once they are past expiry plus the grace period,
 * unless the owner placed a retention hold.
 */
export async function runRetention(db: D1Database, config: Config, now: Date): Promise<RetentionResult> {
  const settings = await getSettings(db, config);
  const conversationCutoff = iso(new Date(now.getTime() - settings.expired_grace_days * DAY));
  const auditCutoff = iso(new Date(now.getTime() - settings.audit_retention_days * DAY));
  const outboxCutoff = iso(new Date(now.getTime() - 30 * DAY));
  const nowIso = iso(now);

  const results = await db.batch([
    // RETURNING gives an exact count; meta.changes would include cascaded child rows.
    db.prepare('DELETE FROM conversations WHERE expires_at <= ?1 AND retention_hold = 0 RETURNING id').bind(conversationCutoff),
    db.prepare('DELETE FROM abuse_events WHERE expires_at <= ?1').bind(nowIso),
    db.prepare('DELETE FROM rate_limit_counters WHERE expires_at <= ?1').bind(nowIso),
    db.prepare('DELETE FROM admin_audit WHERE created_at < ?1').bind(auditCutoff),
    db
      .prepare(`DELETE FROM notification_outbox WHERE status IN ('sent','suppressed','disabled','dead') AND created_at < ?1`)
      .bind(outboxCutoff),
  ]);
  const result: RetentionResult = {
    conversations_deleted: results[0]?.results.length ?? 0,
    abuse_events_deleted: results[1]?.meta.changes ?? 0,
    rate_limit_counters_deleted: results[2]?.meta.changes ?? 0,
    audit_events_deleted: results[3]?.meta.changes ?? 0,
    outbox_rows_deleted: results[4]?.meta.changes ?? 0,
  };
  await auditStatement(db, 'system:retention', 'retention.run', 'system', null, { ...result }, now).run();
  return result;
}

/** Hourly-ish housekeeping that is cheap enough to run with the outbox cron. */
export async function purgeExpiredCounters(db: D1Database, now: Date): Promise<void> {
  await db.prepare('DELETE FROM rate_limit_counters WHERE expires_at <= ?1').bind(iso(now)).run();
}
