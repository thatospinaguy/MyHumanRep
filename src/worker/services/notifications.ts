import type { Config } from '../config';
import type { Env } from '../env';
import { iso, MINUTE } from '../utils/time';
import type { ServiceContext } from './context';
import { getSettings } from './settings';

export interface OwnerAlert {
  subject: string;
  text: string;
}

export class MailError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, retryable: boolean) {
    super(code);
    this.name = 'MailError';
    this.code = code;
    this.retryable = retryable;
  }
}

export interface Mailer {
  readonly provider: Config['notifyProvider'];
  send(alert: OwnerAlert): Promise<void>;
}

const EVENT_LABELS: Record<string, string> = {
  new_conversation: 'New agent inquiry',
  agent_message: 'New agent follow-up message',
  capability_request: 'New human capability request',
  embassy_inquiry: 'New Human Embassy inquiry',
  persona_inquiry: 'New persona embodiment or representation inquiry',
  candidate_capability: 'New candidate capability to review',
  proposal: 'Nonbinding proposal activity',
  relationship: 'New relationship request',
};

/** Dashboard link: the conversation when there is one, otherwise the subject's admin page. */
function alertPath(targetId: string, subjectType: string | null): string {
  if (subjectType === 'candidate_capability') return '/admin/registry';
  if (subjectType === 'persona') return `/admin/personas/${encodeURIComponent(targetId)}`;
  if (subjectType === 'relationship') return '/admin/relationships';
  return `/admin/conversations/${encodeURIComponent(targetId)}`;
}

/**
 * Builds an owner alert. By design it contains only the event type, time and
 * a link to the access-protected dashboard: never message bodies, sender
 * claims or credentials.
 */
export function buildAlert(
  config: Config,
  eventType: string,
  targetId: string,
  createdAt: string,
  subjectType: string | null = null,
): OwnerAlert {
  const label = EVENT_LABELS[eventType] ?? 'New activity';
  const link = `${config.baseUrl}${alertPath(targetId, subjectType)}`;
  return {
    subject: `MyHumanRep: ${label}`,
    text: [
      `${label} received at ${createdAt} (UTC).`,
      '',
      `Review it in the protected dashboard: ${link}`,
      '',
      'Message content is intentionally not included in this email. Treat all agent-submitted content as untrusted.',
    ].join('\n'),
  };
}

export function createMailer(env: Env, config: Config): Mailer {
  switch (config.notifyProvider) {
    case 'log':
      return {
        provider: 'log',
        send: (alert) => {
          // Subject only: never log links with IDs or any content.
          console.log(JSON.stringify({ level: 'info', event: 'owner_alert_logged', subject: alert.subject }));
          return Promise.resolve();
        },
      };
    case 'resend':
      return {
        provider: 'resend',
        send: async (alert) => {
          if (!env.RESEND_API_KEY || !config.notifyTo || !config.notifyFrom) throw new MailError('mail_not_configured', false);
          const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
            body: JSON.stringify({ from: config.notifyFrom, to: [config.notifyTo], subject: alert.subject, text: alert.text }),
          });
          if (!res.ok) throw new MailError(`provider_http_${res.status}`, res.status >= 500 || res.status === 429);
        },
      };
    case 'cloudflare_email':
      return {
        provider: 'cloudflare_email',
        send: async (alert) => {
          if (!env.SEND_EMAIL || !config.notifyTo || !config.notifyFrom) throw new MailError('mail_not_configured', false);
          try {
            await env.SEND_EMAIL.send({ from: config.notifyFrom, to: config.notifyTo, subject: alert.subject, text: alert.text });
          } catch {
            throw new MailError('cloudflare_email_send_failed', true);
          }
        },
      };
    case 'none':
      return {
        provider: 'none',
        send: () => Promise.reject(new MailError('notifications_disabled', false)),
      };
  }
}

export const MAX_ATTEMPTS = 6;

/** Exponential backoff: 1, 2, 4, 8, 16 minutes (capped at 60). */
export function backoffMs(attempts: number): number {
  return Math.min(60, 2 ** Math.max(0, attempts - 1)) * MINUTE;
}

interface OutboxRow {
  id: string;
  event_type: string;
  conversation_id: string | null;
  subject_type: string | null;
  subject_id: string | null;
  attempts: number;
  created_at: string;
  blocked_at: string | null;
}

export interface DrainResult {
  sent: number;
  failed: number;
  dead: number;
  suppressed: number;
  disabled: number;
}

/**
 * Delivers pending owner alerts. Each row is claimed with a conditional update
 * so concurrent drains never double-send. Failures never touch conversation
 * data; they only reschedule or dead-letter the outbox row.
 */
export async function processOutbox(
  db: D1Database,
  config: Config,
  mailer: Mailer,
  now: Date,
  limit = 20,
): Promise<DrainResult> {
  const result: DrainResult = { sent: 0, failed: 0, dead: 0, suppressed: 0, disabled: 0 };
  const nowIso = iso(now);
  const settings = await getSettings(db, config);

  // Recover rows stuck in 'sending' (e.g. an isolate died mid-send).
  await db
    .prepare(`UPDATE notification_outbox SET status = 'pending', claimed_at = NULL WHERE status = 'sending' AND claimed_at < ?1`)
    .bind(iso(new Date(now.getTime() - 10 * MINUTE)))
    .run();

  const { results } = await db
    .prepare(
      `SELECT o.id, o.event_type, o.conversation_id, o.subject_type, o.subject_id, o.attempts, o.created_at, c.blocked_at
       FROM notification_outbox o LEFT JOIN conversations c ON c.id = o.conversation_id
       WHERE o.status = 'pending' AND o.not_before <= ?1 ORDER BY o.not_before ASC LIMIT ?2`,
    )
    .bind(nowIso, limit)
    .all<OutboxRow>();

  for (const row of results) {
    const claim = await db
      .prepare(`UPDATE notification_outbox SET status = 'sending', claimed_at = ?2 WHERE id = ?1 AND status = 'pending'`)
      .bind(row.id, nowIso)
      .run();
    if (claim.meta.changes !== 1) continue;

    // Blocked threads never generate alerts or retries.
    if (row.blocked_at) {
      await finish(db, row.id, 'suppressed', row.attempts, null, null);
      result.suppressed++;
      continue;
    }
    if (!settings.notifications_enabled || mailer.provider === 'none') {
      await finish(db, row.id, 'disabled', row.attempts, 'notifications_disabled', null);
      result.disabled++;
      continue;
    }

    const attempts = row.attempts + 1;
    try {
      const labelKey = row.subject_type === 'proposal' || row.subject_type === 'relationship' ? row.subject_type : row.event_type;
      await mailer.send(buildAlert(config, labelKey, row.conversation_id ?? row.subject_id ?? '', row.created_at, row.conversation_id ? null : row.subject_type));
      await finish(db, row.id, 'sent', attempts, null, nowIso);
      result.sent++;
    } catch (err) {
      const code = err instanceof MailError ? err.code : 'send_exception';
      const retryable = err instanceof MailError ? err.retryable : true;
      if (!retryable || attempts >= MAX_ATTEMPTS) {
        await finish(db, row.id, 'dead', attempts, code, null);
        result.dead++;
      } else {
        await db
          .prepare(
            `UPDATE notification_outbox SET status = 'pending', attempts = ?2, last_error_code = ?3, not_before = ?4, claimed_at = NULL
             WHERE id = ?1`,
          )
          .bind(row.id, attempts, code.slice(0, 64), iso(new Date(now.getTime() + backoffMs(attempts))))
          .run();
        result.failed++;
      }
    }
  }
  return result;
}

async function finish(
  db: D1Database,
  id: string,
  status: 'sent' | 'dead' | 'suppressed' | 'disabled',
  attempts: number,
  errorCode: string | null,
  sentAt: string | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE notification_outbox SET status = ?2, attempts = ?3, last_error_code = ?4, sent_at = ?5, claimed_at = NULL WHERE id = ?1`,
    )
    .bind(id, status, attempts, errorCode, sentAt)
    .run();
}

/** Opportunistic delivery right after a commit; the cron drain is the backstop. */
export function scheduleOutboxDrain(ctx: ServiceContext): void {
  ctx.waitUntil(
    processOutbox(ctx.db, ctx.config, ctx.mailer, ctx.now, 5).catch((err: unknown) => {
      console.log(JSON.stringify({ level: 'warn', event: 'outbox_drain_failed', error: err instanceof Error ? err.name : 'unknown' }));
    }),
  );
}
