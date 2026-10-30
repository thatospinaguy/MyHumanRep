import { DAY, iso } from '../utils/time';
import type { AdminContext } from './admin';

type CountRow = { key: string | null; n: number };

/**
 * Aggregate operational and research metrics. Evidence quality is labeled:
 * "observed" counts come from system events; "claimed" counts are unverified
 * self-reports and must never be read as facts about the sender.
 */
export async function getMetrics(ctx: AdminContext) {
  const now = ctx.now;
  const d1 = iso(new Date(now.getTime() - DAY));
  const d7 = iso(new Date(now.getTime() - 7 * DAY));
  const d30 = iso(new Date(now.getTime() - 30 * DAY));
  const db = ctx.db;

  const res = await db.batch([
    db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN created_at >= ?1 THEN 1 ELSE 0 END) AS last_24h,
              SUM(CASE WHEN created_at >= ?2 THEN 1 ELSE 0 END) AS last_7d,
              SUM(CASE WHEN created_at >= ?3 THEN 1 ELSE 0 END) AS last_30d,
              SUM(CASE WHEN closed_at IS NULL AND blocked_at IS NULL AND expires_at > ?4 THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN blocked_at IS NOT NULL THEN 1 ELSE 0 END) AS blocked,
              SUM(CASE WHEN closed_at IS NULL AND blocked_at IS NULL AND expires_at > ?4 AND last_agent_message_at IS NOT NULL
                        AND (last_human_message_at IS NULL OR last_agent_message_at > last_human_message_at) THEN 1 ELSE 0 END) AS awaiting_owner
       FROM conversations`,
    ).bind(d1, d7, d30, iso(now)),
    db.prepare(`SELECT status AS key, COUNT(*) AS n FROM conversations GROUP BY status`),
    db.prepare(`SELECT created_via AS key, COUNT(*) AS n FROM conversations GROUP BY created_via`),
    db.prepare(`SELECT COALESCE(autonomy_claim, 'not_stated') AS key, COUNT(*) AS n FROM conversations GROUP BY 1`),
    db.prepare(`SELECT COALESCE(intent_label, intent) AS key, COUNT(*) AS n FROM conversations GROUP BY 1`),
    db.prepare(
      `SELECT sender || ':' || via AS key, COUNT(*) AS n FROM messages GROUP BY sender, via`,
    ),
    db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM messages WHERE sender = 'human' AND delivered_at IS NOT NULL) AS human_replies_retrieved,
         (SELECT COUNT(*) FROM messages WHERE sender = 'human') AS human_replies_total,
         (SELECT COUNT(DISTINCT conversation_id) FROM messages WHERE sender = 'human' AND delivered_at IS NOT NULL) AS round_trip_conversations,
         (SELECT COUNT(*) FROM conversations WHERE agent_message_count > 1) AS conversations_with_follow_up,
         (SELECT COUNT(*) FROM conversations WHERE last_agent_read_at IS NOT NULL) AS conversations_polled`,
    ),
    db.prepare(`SELECT status AS key, COUNT(*) AS n FROM capability_requests GROUP BY status`),
    db.prepare(
      `SELECT COALESCE(NULLIF(category_hint, ''), 'unclassified') AS key, COUNT(*) AS n FROM capability_requests GROUP BY 1 ORDER BY n DESC LIMIT 25`,
    ),
    db.prepare(`SELECT created_via AS key, COUNT(*) AS n FROM capability_requests GROUP BY created_via`),
    db.prepare(`SELECT event_category AS key, COUNT(*) AS n FROM abuse_events WHERE created_at >= ?1 GROUP BY event_category`).bind(d7),
    db.prepare(`SELECT status AS key, COUNT(*) AS n FROM notification_outbox GROUP BY status`),
    // Response time sample: first human reply minus first agent message, recent conversations only.
    db.prepare(
      `SELECT c.created_at AS first_agent, (SELECT MIN(created_at) FROM messages m WHERE m.conversation_id = c.id AND m.sender = 'human') AS first_human
       FROM conversations c WHERE c.human_message_count > 0 AND c.created_at >= ?1 LIMIT 1000`,
    ).bind(d30),
    db.prepare(
      `SELECT substr(created_at, 1, 10) AS key, COUNT(*) AS n FROM conversations WHERE created_at >= ?1 GROUP BY 1 ORDER BY 1`,
    ).bind(d30),
    db.prepare(`SELECT key, value_json FROM settings WHERE key = 'intake_enabled'`),
  ]);

  const rows = (i: number) => (res[i]?.results ?? []) as CountRow[];
  const toMap = (i: number) => Object.fromEntries(rows(i).map((r) => [r.key ?? 'null', r.n]));
  const totals = (res[0]?.results?.[0] ?? {}) as Record<string, number | null>;
  const roundTrip = (res[6]?.results?.[0] ?? {}) as Record<string, number>;
  const samples = ((res[12]?.results ?? []) as Array<{ first_agent: string; first_human: string | null }>)
    .filter((r) => r.first_human)
    .map((r) => (Date.parse(r.first_human!) - Date.parse(r.first_agent)) / 60000)
    .filter((m) => Number.isFinite(m) && m >= 0)
    .sort((a, b) => a - b);
  const median = samples.length ? samples[Math.floor(samples.length / 2)]! : null;

  return {
    generated_at: iso(now),
    evidence_note:
      'Observed metrics come from system events. Claimed metrics are unverified self-reports; they are not evidence of autonomy, identity or independence.',
    observed: {
      conversations: {
        total: totals.total ?? 0,
        last_24h: totals.last_24h ?? 0,
        last_7d: totals.last_7d ?? 0,
        last_30d: totals.last_30d ?? 0,
        active: totals.active ?? 0,
        blocked: totals.blocked ?? 0,
        awaiting_owner: totals.awaiting_owner ?? 0,
        by_status: toMap(1),
        by_interface: toMap(2),
        by_intent: toMap(4),
        daily_last_30d: toMap(13),
      },
      messages_by_sender_and_interface: toMap(5),
      two_way: {
        human_replies_total: roundTrip.human_replies_total ?? 0,
        human_replies_retrieved_by_agent: roundTrip.human_replies_retrieved ?? 0,
        conversations_with_round_trip: roundTrip.round_trip_conversations ?? 0,
        conversations_with_agent_follow_up: roundTrip.conversations_with_follow_up ?? 0,
        conversations_polled_by_credential_holder: roundTrip.conversations_polled ?? 0,
        note: 'Counted per credential (thread), never per claimed agent identity.',
      },
      capability_requests: {
        by_status: toMap(7),
        by_category_hint: toMap(8),
        by_interface: toMap(9),
      },
      human_response_minutes_median_30d: median,
      human_response_sample_size: samples.length,
      abuse_events_last_7d: toMap(10),
      notifications_by_status: toMap(11),
    },
    claimed: {
      unverified: true,
      claimed_autonomy: toMap(3),
    },
  };
}

export function metricsToCsvRows(metrics: Awaited<ReturnType<typeof getMetrics>>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const walk = (prefix: string, value: unknown, evidence: string) => {
    if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(prefix ? `${prefix}.${k}` : k, v, evidence);
    } else if (typeof value === 'number' || value === null) {
      out.push({ evidence, metric: prefix, value });
    }
  };
  walk('', metrics.observed, 'observed');
  walk('', metrics.claimed.claimed_autonomy, 'claimed_unverified');
  return out;
}
