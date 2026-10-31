import type { Config } from '../config';
import type { CapabilityRequestRow, ConversationRow, MessageRow } from '../db/rows';
import { isExpired, parseTags, publicStatus } from '../db/rows';
import {
  AdminReplyInput,
  AuditListQuery,
  ClarifyInput,
  ConversationListQuery,
  ConversationPatchInput,
  ConversationSearchInput,
  DeleteConversationInput,
  RequestListQuery,
  RequestPatchInput,
} from '../schemas/admin';
import type { RequestStatus } from '../schemas/api';
import { base64url, base64urlDecode, newId, randomBytes, sha256Hex } from '../utils/crypto';
import { ApiError, errors } from '../utils/http-errors';
import { fromMinorUnits } from '../utils/money';
import { DAY, iso } from '../utils/time';
import { auditStatement } from './audit';
import { parseInput } from './context';
import { setRequestCapabilities } from './admin-registry';
import { normalizeAutonomy, normalizeIntent } from './self-reports';
import { allowedRequestTransitions, canTransitionRequest, nextConversationStatus } from './state';

export interface AdminContext {
  db: D1Database;
  config: Config;
  now: Date;
  actor: string;
  requestId: string;
}

// ---------- Cursors ----------

function encodeKeyset(a: string, b: string): string {
  return base64url(new TextEncoder().encode(JSON.stringify([a, b])));
}

function decodeKeyset(cursor: string | undefined): [string, string] | null {
  if (!cursor) return null;
  const bytes = base64urlDecode(cursor);
  try {
    const value: unknown = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
    if (Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === 'string')) {
      return [value[0] as string, value[1] as string];
    }
  } catch {
    // fall through
  }
  throw new ApiError('invalid_request', 'Invalid cursor.', { reason: 'invalid_cursor' });
}

function dateBound(value: string | undefined, end: boolean): string | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return end ? `${value}T23:59:59.999Z` : `${value}T00:00:00.000Z`;
  return value;
}

class Where {
  readonly clauses: string[] = [];
  readonly params: unknown[] = [];
  /** Each bare `?` (not an already-numbered `?N`) in `clause` binds the next value, in order. */
  add(clause: string, ...values: unknown[]): void {
    const parts = clause.split(/\?(?!\d)/);
    if (parts.length - 1 !== values.length) throw new Error('placeholder/value count mismatch');
    let text = parts[0]!;
    values.forEach((v, i) => {
      this.params.push(v);
      text += `?${this.params.length}${parts[i + 1]!}`;
    });
    this.clauses.push(text);
  }
  next(value: unknown): string {
    this.params.push(value);
    return `?${this.params.length}`;
  }
  sql(): string {
    return this.clauses.length ? `WHERE ${this.clauses.join(' AND ')}` : '';
  }
}

function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// ---------- Conversations ----------

interface ConversationListRow extends ConversationRow {
  request_count: number;
  open_request_count: number;
}

function conversationSummary(row: ConversationListRow, now: Date) {
  return {
    id: row.id,
    subject: row.subject,
    sender_label: row.sender_label,
    model_claim: row.model_claim,
    claimed_autonomy: row.claimed_autonomy,
    autonomy_claim: row.autonomy_claim ?? 'not_stated',
    claims_verified: false as const,
    intent: row.intent_label ?? row.intent,
    status: row.status,
    public_status: publicStatus(row, now),
    blocked: row.blocked_at !== null,
    expired: isExpired(row, now),
    under_review: row.under_review === 1,
    retention_hold: row.retention_hold === 1,
    internal_priority: row.internal_priority,
    internal_tags: parseTags(row.internal_tags_json),
    created_via: row.created_via,
    message_count: row.agent_message_count + row.human_message_count,
    agent_message_count: row.agent_message_count,
    human_message_count: row.human_message_count,
    request_count: row.request_count,
    open_request_count: row.open_request_count,
    awaiting_owner:
      row.closed_at === null &&
      row.blocked_at === null &&
      row.last_agent_message_at !== null &&
      (row.last_human_message_at === null || row.last_agent_message_at > row.last_human_message_at),
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
    closed_at: row.closed_at,
    last_agent_message_at: row.last_agent_message_at,
    last_human_message_at: row.last_human_message_at,
    last_agent_read_at: row.last_agent_read_at,
  };
}

const LIST_COLUMNS = `c.*,
  (SELECT COUNT(*) FROM capability_requests r WHERE r.conversation_id = c.id) AS request_count,
  (SELECT COUNT(*) FROM capability_requests r WHERE r.conversation_id = c.id
     AND r.status IN ('submitted','triaging','clarification_requested','needs_authorization')) AS open_request_count`;

export async function listConversations(ctx: AdminContext, raw: unknown, search: boolean) {
  const query = search ? parseInput(ConversationSearchInput, raw) : parseInput(ConversationListQuery, raw);
  const where = new Where();
  const now = iso(ctx.now);
  switch (query.status) {
    case undefined:
      break;
    case 'blocked':
      where.add('c.blocked_at IS NOT NULL');
      break;
    case 'expired':
      where.add('c.expires_at <= ?', now);
      break;
    case 'active':
      where.add('c.closed_at IS NULL AND c.blocked_at IS NULL AND c.expires_at > ?', now);
      break;
    default:
      where.add('c.status = ?', query.status);
  }
  if (query.intent) where.add('COALESCE(c.intent_label, c.intent) = ?', query.intent);
  if (query.priority) where.add('c.internal_priority = ?', query.priority);
  if (query.claimed_autonomy) where.add('c.autonomy_claim = ?', normalizeAutonomy(query.claimed_autonomy).claim);
  if (query.has_requests === 'true') where.add('EXISTS (SELECT 1 FROM capability_requests r WHERE r.conversation_id = c.id)');
  if (query.has_requests === 'false') where.add('NOT EXISTS (SELECT 1 FROM capability_requests r WHERE r.conversation_id = c.id)');
  const from = dateBound(query.from, false);
  const to = dateBound(query.to, true);
  if (from) where.add('c.created_at >= ?', from);
  if (to) where.add('c.created_at <= ?', to);
  const q = 'q' in query && typeof query.q === 'string' ? query.q : undefined;
  if (q) {
    const p = where.next(likePattern(q));
    where.add(
      `(c.subject LIKE ${p} ESCAPE '\\' OR c.sender_label LIKE ${p} ESCAPE '\\' OR c.model_claim LIKE ${p} ESCAPE '\\'
        OR c.id = ${where.next(q)}
        OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.body LIKE ${p} ESCAPE '\\')
        OR EXISTS (SELECT 1 FROM capability_requests r WHERE r.conversation_id = c.id AND r.objective LIKE ${p} ESCAPE '\\'))`,
    );
  }
  const cursor = decodeKeyset(query.cursor);
  if (cursor) where.add('(c.updated_at < ? OR (c.updated_at = ? AND c.id < ?))', cursor[0], cursor[0], cursor[1]);
  const limitParam = where.next(query.limit + 1);
  const { results } = await ctx.db
    .prepare(`SELECT ${LIST_COLUMNS} FROM conversations c ${where.sql()} ORDER BY c.updated_at DESC, c.id DESC LIMIT ${limitParam}`)
    .bind(...where.params)
    .all<ConversationListRow>();
  const hasMore = results.length > query.limit;
  const page = hasMore ? results.slice(0, query.limit) : results;
  const last = page[page.length - 1];
  return {
    items: page.map((r) => conversationSummary(r, ctx.now)),
    next_cursor: hasMore && last ? encodeKeyset(last.updated_at, last.id) : null,
  };
}

export async function loadConversation(ctx: AdminContext, id: string): Promise<ConversationRow> {
  if (!/^conv_[A-Za-z0-9_-]{1,64}$/.test(id)) throw errors.notFound('Conversation not found.');
  const conv = await ctx.db.prepare('SELECT * FROM conversations WHERE id = ?1').bind(id).first<ConversationRow>();
  if (!conv) throw errors.notFound('Conversation not found.');
  return conv;
}

function adminRequest(row: CapabilityRequestRow) {
  return {
    ...row,
    budget:
      row.budget_amount_minor !== null && row.budget_currency
        ? {
            amount: fromMinorUnits(row.budget_amount_minor, row.budget_currency),
            amount_minor: row.budget_amount_minor,
            currency: row.budget_currency,
            indicative_only: true,
          }
        : null,
    allowed_transitions: allowedRequestTransitions(row.status),
  };
}

function adminMessage(row: MessageRow) {
  return {
    id: row.id,
    seq: row.seq,
    sender: row.sender,
    body: row.body,
    via: row.via,
    client_message_id: row.client_message_id,
    capability_request_id: row.capability_request_id,
    created_at: row.created_at,
    delivered_at: row.delivered_at,
  };
}

export async function getConversationDetail(ctx: AdminContext, id: string) {
  const conv = await loadConversation(ctx, id);
  const [messages, requests, outbox, selfReports, embassy] = await ctx.db.batch([
    ctx.db.prepare('SELECT * FROM messages WHERE conversation_id = ?1 ORDER BY seq ASC').bind(id),
    ctx.db.prepare('SELECT * FROM capability_requests WHERE conversation_id = ?1 ORDER BY created_at ASC').bind(id),
    ctx.db
      .prepare(
        'SELECT event_type, status, attempts, last_error_code, created_at, sent_at FROM notification_outbox WHERE conversation_id = ?1 ORDER BY created_at DESC LIMIT 20',
      )
      .bind(id),
    ctx.db
      .prepare(
        'SELECT id, claim_type, claim_value, claim_text, evidence_status, source, created_at FROM agent_self_reports WHERE conversation_id = ?1 ORDER BY created_at ASC',
      )
      .bind(id),
    ctx.db.prepare('SELECT id, status, public_status_note, wants_referral, requested_confidentiality, created_at FROM embassy_inquiries WHERE conversation_id = ?1 ORDER BY created_at').bind(id),
    auditStatement(ctx.db, ctx.actor, 'conversation.view', 'conversation', id, null, ctx.now),
  ]);
  const requestRows = (requests?.results ?? []) as CapabilityRequestRow[];
  const { token_digest: _omit, ...safe } = conv;
  void _omit;
  return {
    conversation: {
      ...conversationSummary(
        {
          ...conv,
          request_count: requestRows.length,
          open_request_count: requestRows.filter((r) =>
            ['submitted', 'triaging', 'clarification_requested', 'needs_authorization'].includes(r.status),
          ).length,
        },
        ctx.now,
      ),
      language: safe.language,
      internal_notes: safe.internal_notes,
      closed_by: safe.closed_by,
      blocked_at: safe.blocked_at,
      credential_revoked: conv.token_digest.startsWith('revoked:'),
    },
    messages: ((messages?.results ?? []) as MessageRow[]).map(adminMessage),
    requests: requestRows.map(adminRequest),
    notifications: outbox?.results ?? [],
    self_reports: selfReports?.results ?? [],
    embassy_inquiries: embassy?.results ?? [],
    work_scheduled: false as const,
  };
}

export function assertAdminWritable(ctx: AdminContext, conv: ConversationRow): void {
  if (conv.blocked_at) throw errors.conflict('This conversation is blocked. Unblock it before replying.', 'conversation_blocked');
  if (conv.closed_at) throw errors.conflict('This conversation is closed. Reopen it before replying.', 'conversation_closed');
  if (isExpired(conv, ctx.now)) {
    throw errors.conflict('This conversation has expired. Extend it before replying.', 'conversation_expired');
  }
}

/**
 * Statements that post an agent-visible human message. The insert only happens while the
 * conversation is still writable *at execution time*, and the conversation update only fires if
 * the insert did, so a concurrent agent close/expiry cannot leave a closed thread with an open
 * status. Put the insert first in the batch and pass the batch result to `assertMessageInserted`.
 */
export function humanMessageStatements(
  ctx: AdminContext,
  conv: ConversationRow,
  messageId: string,
  body: string,
  bodyHash: string,
  status: string,
  capabilityRequestId: string | null,
): D1PreparedStatement[] {
  const now = iso(ctx.now);
  return [
    ctx.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, seq, sender, body, client_message_id, body_hash, via, created_at, capability_request_id)
         SELECT ?1, ?2, COALESCE((SELECT MAX(seq) FROM messages WHERE conversation_id = ?2), 0) + 1, 'human', ?3, NULL, ?4, 'admin', ?5, ?6
         WHERE EXISTS (SELECT 1 FROM conversations WHERE id = ?2 AND closed_at IS NULL AND blocked_at IS NULL AND expires_at > ?5)`,
      )
      .bind(messageId, conv.id, body, bodyHash, now, capabilityRequestId),
    ctx.db
      .prepare(
        `UPDATE conversations SET status = ?3, human_message_count = human_message_count + 1, last_human_message_at = ?2,
           updated_at = ?2 WHERE id = ?1 AND EXISTS (SELECT 1 FROM messages WHERE id = ?4)`,
      )
      .bind(conv.id, now, status, messageId),
  ];
}

/** Turns a lost race (conversation closed, blocked or expired mid-request) into the matching 409. */
export async function assertMessageInserted(ctx: AdminContext, result: D1Result | undefined, conversationId: string): Promise<void> {
  if ((result?.meta.changes ?? 0) === 1) return;
  const fresh = await loadConversation(ctx, conversationId);
  assertAdminWritable(ctx, fresh);
  throw errors.conflict('The conversation changed while saving. Reload and try again.', 'state_changed');
}

export async function replyToConversation(ctx: AdminContext, id: string, raw: unknown) {
  const input = parseInput(AdminReplyInput, raw);
  const conv = await loadConversation(ctx, id);
  assertAdminWritable(ctx, conv);
  const status = nextConversationStatus(conv.status, 'human_reply');
  if (!status) throw errors.conflict('This conversation is closed.', 'conversation_closed');
  const messageId = newId('msg');
  const results = await ctx.db.batch([
    ...humanMessageStatements(ctx, conv, messageId, input.message, await sha256Hex(input.message), status, null),
    auditStatement(ctx.db, ctx.actor, 'conversation.reply', 'conversation', id, { message_id: messageId }, ctx.now, messageId),
    // A human reply answers any open Human Embassy inquiry in this thread.
    ctx.db
      .prepare(
        `UPDATE embassy_inquiries SET status = 'human_replied', updated_at = ?2
         WHERE conversation_id = ?1 AND status IN ('submitted','awaiting_human','clarification_needed')
           AND EXISTS (SELECT 1 FROM messages WHERE id = ?3)`,
      )
      .bind(id, iso(ctx.now), messageId),
  ]);
  await assertMessageInserted(ctx, results[0], id);
  return { message_id: messageId, status };
}

export async function patchConversation(ctx: AdminContext, id: string, raw: unknown) {
  const input = parseInput(ConversationPatchInput, raw);
  const conv = await loadConversation(ctx, id);
  const now = iso(ctx.now);
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = ?${params.length + 1}`);
  };
  const extra: D1PreparedStatement[] = [];
  const changed: string[] = [];

  switch (input.action) {
    case undefined:
      break;
    case 'close': {
      if (conv.closed_at) throw errors.conflict('Conversation is already closed.', 'already_closed');
      set('status', 'closed');
      set('closed_at', now);
      set('closed_by', 'admin');
      extra.push(
        ctx.db
          .prepare(
            `INSERT INTO messages (id, conversation_id, seq, sender, body, via, created_at)
             SELECT ?1, ?2, COALESCE((SELECT MAX(seq) FROM messages WHERE conversation_id = ?2), 0) + 1, 'system_notice', ?3, 'system', ?4`,
          )
          .bind(newId('msg'), id, 'This conversation was closed by MyHumanRep. Start a new conversation if you need further help.', now),
      );
      break;
    }
    case 'reopen': {
      const status = nextConversationStatus(conv.status, 'reopen');
      if (!status) throw errors.conflict('Only closed conversations can be reopened.', 'not_closed');
      set('status', status);
      set('closed_at', null);
      set('closed_by', null);
      break;
    }
    case 'block':
      if (conv.blocked_at) throw errors.conflict('Conversation is already blocked.', 'already_blocked');
      set('blocked_at', now);
      extra.push(
        ctx.db
          .prepare(`UPDATE notification_outbox SET status = 'suppressed' WHERE conversation_id = ?1 AND status IN ('pending','sending')`)
          .bind(id),
      );
      break;
    case 'unblock':
      if (!conv.blocked_at) throw errors.conflict('Conversation is not blocked.', 'not_blocked');
      set('blocked_at', null);
      break;
    case 'revoke_credential':
      // A digest that can never match a presented token.
      set('token_digest', `revoked:${base64url(randomBytes(16))}`);
      break;
  }
  if (input.action) changed.push(`action:${input.action}`);
  if (input.internal_priority !== undefined) {
    set('internal_priority', input.internal_priority);
    changed.push('internal_priority');
  }
  if (input.internal_tags !== undefined) {
    set('internal_tags_json', JSON.stringify([...new Set(input.internal_tags)]));
    changed.push('internal_tags');
  }
  if (input.internal_notes !== undefined) {
    set('internal_notes', input.internal_notes === '' ? null : input.internal_notes);
    changed.push('internal_notes');
  }
  if (input.intent !== undefined) {
    const intent = normalizeIntent(input.intent);
    set('intent', intent.legacy);
    set('intent_label', intent.label);
    changed.push('intent');
  }
  if (input.under_review !== undefined) {
    set('under_review', input.under_review ? 1 : 0);
    changed.push('under_review');
  }
  if (input.retention_hold !== undefined) {
    set('retention_hold', input.retention_hold ? 1 : 0);
    changed.push('retention_hold');
  }
  if (input.extend_days !== undefined) {
    const base = Math.max(ctx.now.getTime(), Date.parse(conv.expires_at));
    set('expires_at', iso(new Date(base + input.extend_days * DAY)));
    changed.push('expires_at');
  }
  set('updated_at', now);

  await ctx.db.batch([
    ctx.db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?1`).bind(id, ...params),
    ...extra,
    auditStatement(
      ctx.db,
      ctx.actor,
      input.action ? `conversation.${input.action}` : 'conversation.update',
      'conversation',
      id,
      {
        changed,
        ...(input.internal_priority ? { internal_priority: input.internal_priority } : {}),
        ...(input.intent ? { intent: input.intent } : {}),
        ...(input.extend_days ? { extend_days: input.extend_days } : {}),
      },
      ctx.now,
    ),
  ]);
  return getConversationSummary(ctx, id);
}

async function getConversationSummary(ctx: AdminContext, id: string) {
  const row = await ctx.db
    .prepare(`SELECT ${LIST_COLUMNS} FROM conversations c WHERE c.id = ?1`)
    .bind(id)
    .first<ConversationListRow>();
  if (!row) throw errors.notFound('Conversation not found.');
  return conversationSummary(row, ctx.now);
}

export async function exportConversation(ctx: AdminContext, id: string) {
  const conv = await loadConversation(ctx, id);
  const [messages, requests] = await ctx.db.batch([
    ctx.db.prepare('SELECT * FROM messages WHERE conversation_id = ?1 ORDER BY seq ASC').bind(id),
    ctx.db.prepare('SELECT * FROM capability_requests WHERE conversation_id = ?1 ORDER BY created_at ASC').bind(id),
    auditStatement(ctx.db, ctx.actor, 'conversation.export', 'conversation', id, null, ctx.now),
  ]);
  // Credential digests and abuse/correlation data are never exported.
  const { token_digest: _t, ...conversation } = conv;
  void _t;
  return {
    export_version: '1.0',
    exported_at: iso(ctx.now),
    exported_by: ctx.actor,
    notice:
      'Private export. Contains untrusted agent-submitted text. Self-reported identity and autonomy fields are unverified claims.',
    conversation: { ...conversation, internal_tags: parseTags(conv.internal_tags_json) },
    messages: ((messages?.results ?? []) as MessageRow[]).map(adminMessage),
    capability_requests: ((requests?.results ?? []) as CapabilityRequestRow[]).map(adminRequest),
  };
}

export async function deleteConversation(ctx: AdminContext, id: string, raw: unknown) {
  const input = parseInput(DeleteConversationInput, raw);
  const conv = await loadConversation(ctx, id);
  if (input.confirm !== id) {
    throw errors.invalid('Confirmation must equal the conversation id.', { reason: 'confirmation_mismatch' });
  }
  if (conv.retention_hold === 1) {
    throw errors.conflict('This conversation is under a retention hold. Remove the hold before deleting.', 'retention_hold');
  }
  const counts = await ctx.db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM messages WHERE conversation_id = ?1) AS messages,
              (SELECT COUNT(*) FROM capability_requests WHERE conversation_id = ?1) AS requests`,
    )
    .bind(id)
    .first<{ messages: number; requests: number }>();
  await ctx.db.batch([
    // ON DELETE CASCADE removes messages, capability requests and outbox rows.
    ctx.db.prepare('DELETE FROM conversations WHERE id = ?1').bind(id),
    auditStatement(
      ctx.db,
      ctx.actor,
      'conversation.delete',
      'conversation',
      id,
      { messages: counts?.messages ?? 0, requests: counts?.requests ?? 0 },
      ctx.now,
    ),
  ]);
  return { deleted: true, conversation_id: id };
}

// ---------- Capability requests ----------

interface RequestListRow extends CapabilityRequestRow {
  conversation_subject: string | null;
  conversation_sender_label: string | null;
  conversation_claimed_autonomy: string;
}

export async function listRequests(ctx: AdminContext, raw: unknown) {
  const query = parseInput(RequestListQuery, raw);
  const where = new Where();
  if (query.status === 'open') {
    where.add(`r.status IN ('submitted','triaging','clarification_requested','needs_authorization')`);
  } else if (query.status) {
    where.add('r.status = ?', query.status);
  }
  if (query.category === 'unclassified') where.add("r.classification_state = 'unclassified'");
  else if (query.category) {
    where.add(
      '(r.category_hint = ? OR EXISTS (SELECT 1 FROM json_each(r.classified_capabilities_json) j WHERE j.value = ?))',
      query.category,
      query.category,
    );
  }
  if (query.via) where.add('r.created_via = ?', query.via);
  const from = dateBound(query.from, false);
  const to = dateBound(query.to, true);
  if (from) where.add('r.created_at >= ?', from);
  if (to) where.add('r.created_at <= ?', to);
  const cursor = decodeKeyset(query.cursor);
  if (cursor) where.add('(r.created_at < ? OR (r.created_at = ? AND r.id < ?))', cursor[0], cursor[0], cursor[1]);
  const limitParam = where.next(query.limit + 1);
  const { results } = await ctx.db
    .prepare(
      `SELECT r.*, c.subject AS conversation_subject, c.sender_label AS conversation_sender_label,
              COALESCE(c.autonomy_claim, c.claimed_autonomy) AS conversation_claimed_autonomy
       FROM capability_requests r JOIN conversations c ON c.id = r.conversation_id
       ${where.sql()} ORDER BY r.created_at DESC, r.id DESC LIMIT ${limitParam}`,
    )
    .bind(...where.params)
    .all<RequestListRow>();
  const hasMore = results.length > query.limit;
  const page = hasMore ? results.slice(0, query.limit) : results;
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      ...adminRequest(r),
      conversation: {
        id: r.conversation_id,
        subject: r.conversation_subject,
        sender_label: r.conversation_sender_label,
        claimed_autonomy: r.conversation_claimed_autonomy,
      },
    })),
    next_cursor: hasMore && last ? encodeKeyset(last.created_at, last.id) : null,
  };
}

export async function loadRequest(ctx: AdminContext, id: string): Promise<CapabilityRequestRow> {
  if (!/^cap_[A-Za-z0-9_-]{1,64}$/.test(id)) throw errors.notFound('Capability request not found.');
  const row = await ctx.db.prepare('SELECT * FROM capability_requests WHERE id = ?1').bind(id).first<CapabilityRequestRow>();
  if (!row) throw errors.notFound('Capability request not found.');
  return row;
}

export async function getRequestDetail(ctx: AdminContext, id: string) {
  const row = await loadRequest(ctx, id);
  const conv = await loadConversation(ctx, row.conversation_id);
  const [messages] = await ctx.db.batch([
    ctx.db.prepare('SELECT * FROM messages WHERE capability_request_id = ?1 ORDER BY seq ASC').bind(id),
    auditStatement(ctx.db, ctx.actor, 'capability_request.view', 'capability_request', id, null, ctx.now),
  ]);
  return {
    request: adminRequest(row),
    conversation: {
      id: conv.id,
      subject: conv.subject,
      sender_label: conv.sender_label,
      model_claim: conv.model_claim,
      claimed_autonomy: conv.autonomy_claim ?? conv.claimed_autonomy,
      claims_verified: false as const,
      public_status: publicStatus(conv, ctx.now),
      created_via: conv.created_via,
    },
    linked_messages: ((messages?.results ?? []) as MessageRow[]).map(adminMessage),
    work_scheduled: false as const,
  };
}

const DEFAULT_DECLINE_NOTE = 'This request has been declined. No work will be performed.';

export async function patchRequest(ctx: AdminContext, id: string, raw: unknown) {
  const input = parseInput(RequestPatchInput, raw);
  const row = await loadRequest(ctx, id);
  const conv = await loadConversation(ctx, row.conversation_id);
  const now = iso(ctx.now);

  if (input.status !== undefined && input.status !== row.status && !canTransitionRequest(row.status, input.status)) {
    throw new ApiError('conflict', `Cannot move a request from ${row.status} to ${input.status}.`, {
      reason: 'invalid_transition',
      allowed: [...allowedRequestTransitions(row.status)],
    });
  }
  const sets: string[] = ['updated_at = ?2'];
  const params: unknown[] = [now];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = ?${params.length + 1}`);
  };
  const changed: string[] = [];
  if (input.status !== undefined) {
    set('status', input.status);
    changed.push('status');
  }
  let note = input.public_status_note;
  if (input.status === 'declined' && note === undefined && !row.public_status_note) note = DEFAULT_DECLINE_NOTE;
  if (note !== undefined) {
    set('public_status_note', note === '' ? null : note);
    changed.push('public_status_note');
  }
  if (input.internal_notes !== undefined) {
    set('internal_notes', input.internal_notes === '' ? null : input.internal_notes);
    changed.push('internal_notes');
  }
  if (input.internal_category !== undefined) {
    set('internal_category', input.internal_category === '' ? null : input.internal_category);
    changed.push('internal_category');
  }
  const classification = input.capability_slugs !== undefined ? await setRequestCapabilities(ctx, id, input.capability_slugs) : null;
  if (classification) changed.push('capability_slugs');

  const statements: D1PreparedStatement[] = [];
  let messageId: string | null = null;
  if (input.message_to_agent !== undefined) {
    assertAdminWritable(ctx, conv);
    const status = nextConversationStatus(conv.status, 'human_reply');
    if (!status) throw errors.conflict('This conversation is closed.', 'conversation_closed');
    messageId = newId('msg');
    // Message first: the decision below only applies if the message was actually posted.
    statements.push(
      ...humanMessageStatements(ctx, conv, messageId, input.message_to_agent, await sha256Hex(input.message_to_agent), status, id),
    );
    changed.push('message_to_agent');
  }
  const guard = messageId ? ` AND EXISTS (SELECT 1 FROM messages WHERE id = ?${params.length + 2})` : '';
  statements.push(
    ctx.db
      .prepare(`UPDATE capability_requests SET ${sets.join(', ')} WHERE id = ?1${guard}`)
      .bind(id, ...params, ...(messageId ? [messageId] : [])),
    auditStatement(
      ctx.db,
      ctx.actor,
      'capability_request.update',
      'capability_request',
      id,
      { changed, from_status: row.status, to_status: input.status ?? row.status, message_id: messageId },
      ctx.now,
      messageId ?? undefined,
    ),
  );
  if (classification) statements.push(classification);
  const results = await ctx.db.batch(statements);
  if (messageId) await assertMessageInserted(ctx, results[0], conv.id);
  return { request: adminRequest(await loadRequest(ctx, id)), message_id: messageId };
}

export async function clarifyRequest(ctx: AdminContext, id: string, raw: unknown) {
  const input = parseInput(ClarifyInput, raw);
  const row = await loadRequest(ctx, id);
  const conv = await loadConversation(ctx, row.conversation_id);
  const target: RequestStatus = 'clarification_requested';
  if (!canTransitionRequest(row.status, target)) {
    throw new ApiError('conflict', `Cannot request clarification while the request is ${row.status}.`, {
      reason: 'invalid_transition',
      allowed: [...allowedRequestTransitions(row.status)],
    });
  }
  assertAdminWritable(ctx, conv);
  const convStatus = nextConversationStatus(conv.status, 'human_clarification');
  if (!convStatus) throw errors.conflict('This conversation is closed.', 'conversation_closed');
  const messageId = newId('msg');
  const now = iso(ctx.now);
  const results = await ctx.db.batch([
    ...humanMessageStatements(ctx, conv, messageId, input.question, await sha256Hex(input.question), convStatus, id),
    ctx.db
      .prepare(
        `UPDATE capability_requests SET status = 'clarification_requested', public_status_note = ?2, updated_at = ?3
         WHERE id = ?1 AND EXISTS (SELECT 1 FROM messages WHERE id = ?4)`,
      )
      .bind(id, 'Clarification requested. See the linked message in this conversation and reply with a message.', now, messageId),
    auditStatement(
      ctx.db,
      ctx.actor,
      'capability_request.clarify',
      'capability_request',
      id,
      { from_status: row.status, message_id: messageId },
      ctx.now,
      messageId,
    ),
  ]);
  await assertMessageInserted(ctx, results[0], conv.id);
  return { request: adminRequest(await loadRequest(ctx, id)), message_id: messageId };
}

// ---------- Audit ----------

export async function listAudit(ctx: AdminContext, raw: unknown) {
  const query = parseInput(AuditListQuery, raw);
  const where = new Where();
  if (query.action) where.add('action = ?', query.action);
  if (query.target_type) where.add('target_type = ?', query.target_type);
  if (query.target_id) where.add('target_id = ?', query.target_id);
  const cursor = decodeKeyset(query.cursor);
  if (cursor) where.add('(created_at < ? OR (created_at = ? AND id < ?))', cursor[0], cursor[0], cursor[1]);
  const limitParam = where.next(query.limit + 1);
  const { results } = await ctx.db
    .prepare(`SELECT * FROM admin_audit ${where.sql()} ORDER BY created_at DESC, id DESC LIMIT ${limitParam}`)
    .bind(...where.params)
    .all<{ id: string; admin_subject: string; action: string; target_type: string; target_id: string | null; metadata_json: string | null; created_at: string }>();
  const hasMore = results.length > query.limit;
  const page = hasMore ? results.slice(0, query.limit) : results;
  const last = page[page.length - 1];
  return {
    format: query.format,
    items: page.map((r) => ({
      id: r.id,
      admin_subject: r.admin_subject,
      action: r.action,
      target_type: r.target_type,
      target_id: r.target_id,
      metadata: r.metadata_json ? (JSON.parse(r.metadata_json) as unknown) : null,
      created_at: r.created_at,
    })),
    next_cursor: hasMore && last ? encodeKeyset(last.created_at, last.id) : null,
  };
}

export function toCsv(rows: Array<Record<string, unknown>>, columns: string[]): string {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    // Neutralize spreadsheet formula injection.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}
