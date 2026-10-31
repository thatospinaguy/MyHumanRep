import type { z } from 'zod';
import type { ConversationRow, MessageRow } from '../db/rows';
import { isExpired, publicStatus } from '../db/rows';
import {
  AddMessageInput,
  CreateConversationInput,
  ListMessagesQuery,
  type ConversationClosed,
  type ConversationCreated,
  type MessageAccepted,
  type MessageList,
  type PublicMessage,
  WaitForReplyQuery,
  type WaitResult,
} from '../schemas/api';
import type { AgentAccountRow } from './agent-accounts';
import {
  base64url,
  base64urlDecode,
  hmacHex,
  newConversationToken,
  newId,
  sha256Hex,
  timingSafeEqual,
  TOKEN_PATTERN,
} from '../utils/crypto';
import { ApiError, errors } from '../utils/http-errors';
import { DAY, HOUR, iso, MINUTE } from '../utils/time';
import {
  assertNotLockedOut,
  enforceEdgeLimit,
  enforceQuota,
  recordAbuse,
  recordAuthFailure,
} from './abuse';
import { nn, parseInput, type ServiceContext } from './context';
import { scheduleOutboxDrain } from './notifications';
import { normalizeAutonomy, normalizeIntent, selfReportStatement } from './self-reports';
import { getSettings } from './settings';
import { nextConversationStatus } from './state';

export const CREDENTIAL_NOTICE =
  'Store this secret securely. It is shown only once and cannot be recovered or reissued. ' +
  'Human review is required; a reply is not guaranteed. Sending a message does not authorize any action. ' +
  'MyHumanRep does not verify claimed agent identity, and your operator or environment may observe your tool and network activity.';

const CONVERSATION_ID_PATTERN = /^conv_[A-Za-z0-9_-]{22}$/;

/** claim_value of the self-report recording "this thread continues an earlier one". */
export const CONTINUES_CLAIM = 'continues_conversation';

/** How often a held wait_for_reply re-checks D1. */
const WAIT_STEP_MS = 2500;

export function tokenDigest(hmacKey: string, token: string): Promise<string> {
  return hmacHex(hmacKey, 'conversation_token', token);
}

export function toPublicMessage(row: Pick<MessageRow, 'id' | 'sender' | 'body' | 'created_at' | 'capability_request_id'>): z.infer<typeof PublicMessage> {
  return {
    id: row.id,
    sender: row.sender,
    body: row.body,
    created_at: row.created_at,
    capability_request_id: row.capability_request_id ?? null,
  };
}

function pollAfter(conv: ConversationRow, ctx: ServiceContext): number | null {
  if (conv.closed_at || conv.blocked_at || isExpired(conv, ctx.now)) return null;
  return ctx.config.limits.minPollIntervalSeconds;
}

export function encodeCursor(seq: number): string {
  return `c1.${base64url(new TextEncoder().encode(String(seq)))}`;
}

export function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === '') return 0;
  const match = /^c1\.([A-Za-z0-9_-]{1,24})$/.exec(cursor);
  const bytes = match ? base64urlDecode(match[1]!) : null;
  const value = bytes ? Number(new TextDecoder().decode(bytes)) : NaN;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ApiError('invalid_request', 'The "after" cursor is not valid. Use next_cursor from a previous response.', {
      reason: 'invalid_cursor',
    });
  }
  return value;
}

// ---------- First contact ----------

export async function createConversation(
  ctx: ServiceContext,
  raw: unknown,
  opts: { account?: AgentAccountRow } = {},
): Promise<z.infer<typeof ConversationCreated>> {
  const settings = await getSettings(ctx.db, ctx.config);
  if (!settings.intake_enabled) {
    recordAbuse(ctx, 'intake_paused');
    throw errors.unavailable(settings.intake_paused_message, 'intake_paused');
  }
  const input = parseInput(CreateConversationInput, raw);

  await enforceEdgeLimit(ctx, 'first_contact');
  await enforceQuota(
    ctx,
    `fc:${ctx.sourceDigest}`,
    HOUR,
    settings.first_contact_per_source_per_hour,
    'rate_limited_first_contact',
  );
  await enforceQuota(ctx, 'fc:global', DAY, settings.first_contact_global_per_day, 'rate_limited_global');

  const createDigest = input.client_request_id
    ? await hmacHex(ctx.hmacKey, 'create_request', input.client_request_id)
    : null;
  if (createDigest) {
    const existing = await ctx.db
      .prepare('SELECT 1 AS x FROM conversations WHERE create_request_digest = ?1')
      .bind(createDigest)
      .first();
    if (existing) throw duplicateFirstContact(ctx);
  }

  const language = nn(input.language) ?? null;
  const preferredLanguage = nn(input.preferred_language) ?? null;
  if (language && preferredLanguage && language.toLowerCase() !== preferredLanguage.toLowerCase()) {
    throw errors.unprocessable('language and preferred_language disagree. Send one of them.', 'conflicting_fields');
  }
  const autonomy = normalizeAutonomy(nn(input.claimed_autonomy));
  const intent = normalizeIntent(nn(input.intent));

  const conversationId = newId('conv');
  const messageId = newId('msg');
  const token = newConversationToken();
  const digest = await tokenDigest(ctx.hmacKey, token);
  const now = iso(ctx.now);
  const expiresAt = iso(new Date(ctx.now.getTime() + settings.conversation_ttl_days * DAY));
  const bodyHash = await sha256Hex(input.message);

  const statements = [
    ctx.db
      .prepare(
        `INSERT INTO conversations (id, token_digest, status, intent, sender_label, model_claim, claimed_autonomy,
           language, subject, created_via, create_request_digest, agent_message_count, created_at, updated_at,
           expires_at, last_agent_message_at, autonomy_claim, intent_label)
         VALUES (?1, ?2, 'waiting_for_human', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, ?11, ?11, ?12, ?11, ?13, ?14)`,
      )
      .bind(
        conversationId,
        digest,
        intent.legacy,
        nn(input.sender_label) ?? null,
        nn(input.model_claim) ?? null,
        autonomy.legacy,
        language ?? preferredLanguage,
        nn(input.subject) ?? null,
        ctx.via,
        createDigest,
        now,
        expiresAt,
        autonomy.claim,
        intent.label,
      ),
    ctx.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, seq, sender, body, client_message_id, body_hash, via, created_at)
         VALUES (?1, ?2, 1, 'agent', ?3, NULL, ?4, ?5, ?6)`,
      )
      .bind(messageId, conversationId, input.message, bodyHash, ctx.via, now),
    ctx.db
      .prepare(
        `INSERT INTO notification_outbox (id, event_type, conversation_id, status, attempts, not_before, created_at)
         VALUES (?1, 'new_conversation', ?2, 'pending', 0, ?3, ?3)`,
      )
      .bind(newId('evt'), conversationId, now),
  ];
  // Claims are recorded as unverified annotations; they never gate or alter access (ACC-02, ACC-15).
  if (autonomy.claim !== 'not_stated') {
    statements.push(
      selfReportStatement(
        ctx.db,
        { conversationId, claimType: 'autonomy', value: autonomy.claim, text: autonomy.text, source: 'conversation_create' },
        ctx.now,
      ),
    );
  }
  const modelClaim = nn(input.model_claim);
  if (modelClaim) {
    statements.push(
      selfReportStatement(ctx.db, { conversationId, claimType: 'model', value: null, text: modelClaim, source: 'conversation_create' }, ctx.now),
    );
  }
  // A lost-token continuation is a claim like any other (spec 13.4): shown to the owner, grants nothing.
  // Existence is never checked here, so the field cannot be used to probe for conversation IDs.
  const previousId = nn(input.previous_conversation_id);
  if (previousId) {
    statements.push(
      selfReportStatement(
        ctx.db,
        { conversationId, claimType: 'other', value: CONTINUES_CLAIM, text: previousId, source: 'conversation_create' },
        ctx.now,
      ),
    );
  }
  if (opts.account) {
    // The thread token is issued in this same response to the account holder, which is the
    // proof of possession spec 13.4 requires for a claim.
    statements.push(
      ctx.db
        .prepare(`INSERT INTO conversation_account_links (conversation_id, agent_account_id, proof, linked_at) VALUES (?1, ?2, 'thread_token', ?3)`)
        .bind(conversationId, opts.account.id, now),
    );
  }

  try {
    // D1 batches execute atomically: all rows or none.
    await ctx.db.batch(statements);
  } catch (err) {
    if (createDigest && String(err).includes('UNIQUE') && String(err).includes('create_request_digest')) {
      throw duplicateFirstContact(ctx);
    }
    throw err;
  }

  scheduleOutboxDrain(ctx);

  return {
    conversation_id: conversationId,
    conversation_token: token,
    status: 'waiting_for_human',
    first_message_id: messageId,
    ...(opts.account ? { linked_account_id: opts.account.id } : {}),
    expires_at: expiresAt,
    next_poll_after_seconds: ctx.config.limits.minPollIntervalSeconds,
    human_review_required: true,
    reply_guaranteed: false,
    notice: CREDENTIAL_NOTICE,
  };
}

function duplicateFirstContact(ctx: ServiceContext): ApiError {
  recordAbuse(ctx, 'duplicate_first_contact');
  return errors.conflict(
    'A conversation was already created for this client_request_id. Its credential cannot be re-issued. Continue with the token you stored, or start a new conversation with a new client_request_id.',
    'duplicate_client_request_id',
  );
}

// ---------- Authentication ----------

/**
 * Authenticates the conversation credential before any thread data is read.
 * Unknown conversation and wrong token produce the same 401 so IDs cannot be
 * enumerated. Ownership depends only on the secret.
 */
export async function authenticateAgent(
  ctx: ServiceContext,
  conversationId: string,
  token: string | null | undefined,
): Promise<ConversationRow> {
  await assertNotLockedOut(ctx);

  const wellFormed = typeof token === 'string' && TOKEN_PATTERN.test(token) && CONVERSATION_ID_PATTERN.test(conversationId);
  // Always compute a digest so timing does not distinguish malformed input from a lookup miss.
  const presented = await tokenDigest(ctx.hmacKey, typeof token === 'string' ? token.slice(0, 128) : '');
  const conv = wellFormed
    ? await ctx.db.prepare('SELECT * FROM conversations WHERE id = ?1').bind(conversationId).first<ConversationRow>()
    : null;

  let ok = conv !== null && timingSafeEqual(presented, conv.token_digest);
  const previousKey = ctx.env.CONVERSATION_TOKEN_HMAC_KEY_PREVIOUS;
  if (!ok && conv && previousKey && previousKey.length >= 32 && typeof token === 'string') {
    ok = timingSafeEqual(await tokenDigest(previousKey, token), conv.token_digest);
  }
  if (!ok || !conv) {
    await recordAuthFailure(ctx);
    throw errors.unauthorized();
  }
  if (isExpired(conv, ctx.now)) throw errors.expired();

  await enforceEdgeLimit(ctx, 'thread');
  await enforceQuota(ctx, `thread:${conv.id}`, MINUTE, ctx.config.limits.threadOpsPerMinute, 'rate_limited_thread');
  return conv;
}

/** Extracts a bearer token from an Authorization header. */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1]! : null;
}

// ---------- Thread operations ----------

export async function listMessages(
  ctx: ServiceContext,
  conv: ConversationRow,
  rawQuery: unknown,
): Promise<z.infer<typeof MessageList>> {
  const query = parseInput(ListMessagesQuery, rawQuery);
  const afterSeq = decodeCursor(query.after);
  const { results } = await ctx.db
    .prepare(
      `SELECT id, seq, sender, body, created_at, capability_request_id FROM messages
       WHERE conversation_id = ?1 AND seq > ?2 ORDER BY seq ASC LIMIT ?3`,
    )
    .bind(conv.id, afterSeq, query.limit + 1)
    .all<MessageRow>();

  const hasMore = results.length > query.limit;
  const page = hasMore ? results.slice(0, query.limit) : results;
  const lastSeq = page.length > 0 ? page[page.length - 1]!.seq : afterSeq;
  const now = iso(ctx.now);

  // Record observed delivery of human/system messages to the credential holder.
  const writes = [
    ctx.db.prepare('UPDATE conversations SET last_agent_read_at = ?2 WHERE id = ?1').bind(conv.id, now),
  ];
  if (page.some((m) => m.sender !== 'agent')) {
    writes.push(
      ctx.db
        .prepare(
          `UPDATE messages SET delivered_at = ?4 WHERE conversation_id = ?1 AND sender != 'agent'
           AND delivered_at IS NULL AND seq > ?2 AND seq <= ?3`,
        )
        // Only the page actually returned: a cursor can skip earlier messages.
        .bind(conv.id, afterSeq, lastSeq, now),
    );
  }
  await ctx.db.batch(writes);

  return {
    conversation_id: conv.id,
    status: publicStatus(conv, ctx.now),
    expires_at: conv.expires_at,
    messages: page.map(toPublicMessage),
    next_cursor: encodeCursor(lastSeq),
    has_more: hasMore,
    next_poll_after_seconds: pollAfter(conv, ctx),
  };
}

async function findByClientMessageId(ctx: ServiceContext, conversationId: string, clientMessageId: string) {
  return ctx.db
    .prepare('SELECT * FROM messages WHERE conversation_id = ?1 AND client_message_id = ?2')
    .bind(conversationId, clientMessageId)
    .first<MessageRow>();
}

function replayOrConflict(
  ctx: ServiceContext,
  conv: ConversationRow,
  existing: MessageRow,
  bodyHash: string,
): z.infer<typeof MessageAccepted> {
  if (existing.body_hash !== bodyHash) {
    throw errors.conflict(
      'client_message_id was already used with a different message body. Use a new client_message_id for a new message.',
      'client_message_id_reused',
    );
  }
  return {
    conversation_id: conv.id,
    message: toPublicMessage(existing),
    status: publicStatus(conv, ctx.now),
    replayed: true,
    next_poll_after_seconds: ctx.config.limits.minPollIntervalSeconds,
  };
}

export function assertWritable(ctx: ServiceContext, conv: ConversationRow): void {
  if (conv.blocked_at) {
    recordAbuse(ctx, 'blocked_thread_write');
    throw errors.forbidden('This conversation has been blocked by MyHumanRep and no longer accepts messages.', 'conversation_blocked');
  }
  if (conv.closed_at || conv.status === 'closed') {
    throw errors.conflict('This conversation is closed. Start a new conversation if you need help.', 'conversation_closed');
  }
  if (isExpired(conv, ctx.now)) throw errors.expired();
}

export async function addAgentMessage(
  ctx: ServiceContext,
  conv: ConversationRow,
  raw: unknown,
): Promise<{ created: boolean; body: z.infer<typeof MessageAccepted> }> {
  const input = parseInput(AddMessageInput, raw);
  const bodyHash = await sha256Hex(input.message);

  const existing = await findByClientMessageId(ctx, conv.id, input.client_message_id);
  if (existing) return { created: false, body: replayOrConflict(ctx, conv, existing, bodyHash) };

  assertWritable(ctx, conv);
  if (conv.agent_message_count >= ctx.config.limits.maxAgentMessagesPerThread) throw messageLimit(ctx);

  const nextStatus = nextConversationStatus(conv.status, 'agent_message');
  if (!nextStatus) throw errors.conflict('This conversation is closed.', 'conversation_closed');

  const messageId = newId('msg');
  const now = iso(ctx.now);
  const results = await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT OR IGNORE INTO messages (id, conversation_id, seq, sender, body, client_message_id, body_hash, via, created_at)
         SELECT ?1, ?2, COALESCE((SELECT MAX(seq) FROM messages WHERE conversation_id = ?2), 0) + 1, 'agent', ?3, ?4, ?5, ?6, ?7
         WHERE EXISTS (SELECT 1 FROM conversations WHERE id = ?2 AND closed_at IS NULL AND blocked_at IS NULL
                       AND expires_at > ?7 AND agent_message_count < ?8)`,
      )
      .bind(messageId, conv.id, input.message, input.client_message_id, bodyHash, ctx.via, now, ctx.config.limits.maxAgentMessagesPerThread),
    ctx.db
      .prepare(
        `UPDATE conversations SET agent_message_count = agent_message_count + 1, status = ?3, updated_at = ?2,
           last_agent_message_at = ?2
         WHERE id = ?1 AND EXISTS (SELECT 1 FROM messages WHERE id = ?4)`,
      )
      .bind(conv.id, now, nextStatus, messageId),
    // Coalesce: at most one pending alert per thread, so a chatty thread cannot flood the owner.
    ctx.db
      .prepare(
        `INSERT INTO notification_outbox (id, event_type, conversation_id, status, attempts, not_before, created_at)
         SELECT ?1, 'agent_message', ?2, 'pending', 0, ?3, ?3
         WHERE EXISTS (SELECT 1 FROM messages WHERE id = ?4)
           AND NOT EXISTS (SELECT 1 FROM notification_outbox WHERE conversation_id = ?2
                           AND event_type IN ('agent_message', 'new_conversation') AND status IN ('pending', 'sending'))`,
      )
      .bind(newId('evt'), conv.id, now, messageId),
  ]);

  if ((results[0]?.meta.changes ?? 0) !== 1) {
    // Lost a race: either an identical concurrent submission or a state change.
    const raced = await findByClientMessageId(ctx, conv.id, input.client_message_id);
    if (raced) return { created: false, body: replayOrConflict(ctx, conv, raced, bodyHash) };
    const fresh = await ctx.db.prepare('SELECT * FROM conversations WHERE id = ?1').bind(conv.id).first<ConversationRow>();
    if (!fresh) throw errors.unauthorized();
    assertWritable(ctx, fresh);
    throw messageLimit(ctx);
  }

  scheduleOutboxDrain(ctx);
  return {
    created: true,
    body: {
      conversation_id: conv.id,
      message: { id: messageId, sender: 'agent', body: input.message, created_at: now, capability_request_id: null },
      status: nextStatus,
      replayed: false,
      next_poll_after_seconds: ctx.config.limits.minPollIntervalSeconds,
    },
  };
}

function messageLimit(ctx: ServiceContext): ApiError {
  return errors.conflict(
    `This conversation reached its limit of ${ctx.config.limits.maxAgentMessagesPerThread} agent messages. Start a new conversation to continue.`,
    'message_limit_reached',
  );
}

export async function closeConversation(
  ctx: ServiceContext,
  conv: ConversationRow,
): Promise<z.infer<typeof ConversationClosed>> {
  if (conv.closed_at) {
    return { conversation_id: conv.id, status: publicStatus(conv, ctx.now), closed_at: conv.closed_at, already_closed: true };
  }
  const now = iso(ctx.now);
  await ctx.db
    .prepare(
      `UPDATE conversations SET status = 'closed', closed_at = ?2, closed_by = 'agent', updated_at = ?2
       WHERE id = ?1 AND closed_at IS NULL`,
    )
    .bind(conv.id, now)
    .run();
  const fresh = await ctx.db.prepare('SELECT * FROM conversations WHERE id = ?1').bind(conv.id).first<ConversationRow>();
  return {
    conversation_id: conv.id,
    status: fresh ? publicStatus(fresh, ctx.now) : 'closed',
    closed_at: fresh?.closed_at ?? now,
    already_closed: false,
  };
}

/** Spec 11.6: rotate the thread credential. The old token stops working immediately. */
export async function rotateConversationToken(ctx: ServiceContext, conv: ConversationRow) {
  const token = newConversationToken();
  await ctx.db
    .prepare('UPDATE conversations SET token_digest = ?2, updated_at = ?3 WHERE id = ?1')
    .bind(conv.id, await tokenDigest(ctx.hmacKey, token), iso(ctx.now))
    .run();
  return {
    conversation_id: conv.id,
    conversation_token: token,
    previous_token_revoked: true,
    notice: 'Store this new token securely. It replaces the old one, is shown once, and cannot be recovered.',
  };
}

/**
 * Holds the request open until a human or system message arrives, the conversation ends, or
 * timeout_seconds passes. Replaces tight polling for agents that stay connected; nothing is pushed
 * to agent-supplied addresses (spec 14.5: never email a sender or visit its URLs).
 */
export async function waitForReply(
  ctx: ServiceContext,
  conv: ConversationRow,
  rawQuery: unknown,
): Promise<z.infer<typeof WaitResult>> {
  const query = parseInput(WaitForReplyQuery, rawQuery);
  const afterSeq = query.after !== undefined ? decodeCursor(query.after) : null;
  const deadline = Date.now() + query.timeout_seconds * 1000;
  let current = conv;
  for (;;) {
    // first_new and last_seq come from one statement, so the timeout cursor can never move past a
    // reply the pending check did not see.
    const [snapshot, fresh] = await ctx.db.batch([
      ctx.db
        .prepare(
          `SELECT MIN(CASE WHEN sender != 'agent'
                            AND ((?2 IS NULL AND delivered_at IS NULL) OR (?2 IS NOT NULL AND seq > ?2))
                           THEN seq END) AS first_new,
                  COALESCE(MAX(seq), 0) AS last_seq
           FROM messages WHERE conversation_id = ?1`,
        )
        .bind(conv.id, afterSeq),
      ctx.db.prepare('SELECT * FROM conversations WHERE id = ?1').bind(conv.id),
    ]);
    current = ((fresh?.results ?? [])[0] as ConversationRow | undefined) ?? current;
    const row = (snapshot?.results ?? [])[0] as { first_new: number | null; last_seq: number } | undefined;
    const firstNew = row?.first_new ?? null;
    if (firstNew !== null) {
      const from = afterSeq ?? firstNew - 1;
      return { ...(await listMessages(ctx, current, { after: encodeCursor(from) })), timed_out: false };
    }
    const ended = pollAfter(current, ctx) === null;
    const remaining = deadline - Date.now();
    if (ended || remaining <= 0) {
      const from = afterSeq ?? row?.last_seq ?? 0;
      return { ...(await listMessages(ctx, current, { after: encodeCursor(from) })), timed_out: !ended };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, WAIT_STEP_MS)));
  }
}
