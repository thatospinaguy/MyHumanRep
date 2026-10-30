import { ClaimConversationInput, CreateAgentAccountInput } from '../schemas/humanification';
import { base64url, hmacHex, newId, randomBytes, timingSafeEqual } from '../utils/crypto';
import { errors } from '../utils/http-errors';
import { DAY, HOUR, iso, MINUTE } from '../utils/time';
import { assertNotLockedOut, enforceEdgeLimit, enforceQuota, recordAuthFailure } from './abuse';
import { nn, parseInput, type ServiceContext } from './context';
import { authenticateAgent } from './conversations';
import { requireFlag } from './feature-flags';

export const ACCOUNT_TOKEN_PATTERN = /^mhra_[A-Za-z0-9_-]{43}$/;
const ACCOUNT_ID_PATTERN = /^acct_[A-Za-z0-9_-]{22}$/;

export const ACCOUNT_NOTICE =
  'Store this account token securely; it is shown once and cannot be recovered. It proves control of this application account only: it is not human identity, legal status, payment authority, or access to any conversation you have not claimed with that conversation\'s own token.';

export interface AgentAccountRow {
  id: string;
  token_digest: string;
  display_label: string | null;
  status: 'active' | 'suspended' | 'revoked';
  created_via: string;
  terms_accepted_at: string;
  created_at: string;
  updated_at: string;
  last_active_at: string | null;
}

function accountDigest(key: string, token: string): Promise<string> {
  // Purpose-separated from conversation tokens: one can never verify as the other.
  return hmacHex(key, 'agent_account_token', token);
}

function newAccountToken(): string {
  return `mhra_${base64url(randomBytes(32))}`;
}

export async function createAgentAccount(ctx: ServiceContext, raw: unknown) {
  await requireFlag(ctx.db, 'persona_studio_enabled', 'Agent accounts');
  const input = parseInput(CreateAgentAccountInput, raw);
  await enforceEdgeLimit(ctx, 'account');
  await enforceQuota(ctx, `acct:${ctx.sourceDigest}`, HOUR, 5, 'rate_limited_first_contact');
  await enforceQuota(ctx, 'acct:global', DAY, 500, 'rate_limited_global');
  const id = newId('acct');
  const token = newAccountToken();
  const now = iso(ctx.now);
  await ctx.db
    .prepare(
      `INSERT INTO agent_accounts (id, token_digest, display_label, status, created_via, terms_accepted_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'active', ?4, ?5, ?5, ?5)`,
    )
    .bind(id, await accountDigest(ctx.hmacKey, token), nn(input.display_label) ?? null, ctx.via, now)
    .run();
  return {
    account_id: id,
    account_token: token,
    scopes: ['personas:own', 'conversations:claim'],
    identity_verified: false,
    notice: ACCOUNT_NOTICE,
  };
}

/** Bearer extraction for account tokens. Thread tokens (mhr_) never match the account pattern. */
export async function authenticateAccount(ctx: ServiceContext, token: string | null | undefined): Promise<AgentAccountRow> {
  await requireFlag(ctx.db, 'persona_studio_enabled', 'Agent accounts');
  await assertNotLockedOut(ctx);
  const presented = await accountDigest(ctx.hmacKey, typeof token === 'string' ? token.slice(0, 128) : '');
  // Account tokens carry no account id, so the keyed digest is the lookup key (unique index).
  const row =
    typeof token === 'string' && ACCOUNT_TOKEN_PATTERN.test(token)
      ? await ctx.db.prepare('SELECT * FROM agent_accounts WHERE token_digest = ?1').bind(presented).first<AgentAccountRow>()
      : null;
  if (!row || !timingSafeEqual(presented, row.token_digest) || row.status !== 'active') {
    await recordAuthFailure(ctx);
    throw errors.unauthorizedAccount();
  }
  await enforceQuota(ctx, `acctops:${row.id}`, MINUTE, ctx.config.limits.threadOpsPerMinute, 'rate_limited_thread');
  ctx.waitUntil(ctx.db.prepare('UPDATE agent_accounts SET last_active_at = ?2 WHERE id = ?1').bind(row.id, iso(ctx.now)).run().catch(() => undefined));
  return row;
}

export async function getAccountSummary(ctx: ServiceContext, account: AgentAccountRow) {
  const [links, personas] = await ctx.db.batch([
    ctx.db.prepare('SELECT conversation_id, linked_at FROM conversation_account_links WHERE agent_account_id = ?1 ORDER BY linked_at').bind(account.id),
    ctx.db.prepare('SELECT COUNT(*) AS n FROM agent_personas WHERE owner_agent_account_id = ?1').bind(account.id),
  ]);
  return {
    account_id: account.id,
    display_label: account.display_label,
    status: account.status,
    created_at: account.created_at,
    identity_verified: false,
    claimed_conversations: links?.results ?? [],
    persona_count: ((personas?.results?.[0] ?? {}) as { n?: number }).n ?? 0,
  };
}

/**
 * Links exactly one conversation to the account, after proof of possession of that thread's token
 * (spec 13.4). Does not reveal or grant anything about other threads.
 */
export async function claimConversation(ctx: ServiceContext, account: AgentAccountRow, raw: unknown) {
  const input = parseInput(ClaimConversationInput, raw);
  const conv = await authenticateAgent(ctx, input.conversation_id, input.conversation_token);
  const existing = await ctx.db
    .prepare('SELECT agent_account_id, linked_at FROM conversation_account_links WHERE conversation_id = ?1')
    .bind(conv.id)
    .first<{ agent_account_id: string; linked_at: string }>();
  if (existing) {
    if (timingSafeEqual(existing.agent_account_id, account.id)) {
      return { conversation_id: conv.id, linked_at: existing.linked_at, already_linked: true };
    }
    throw errors.conflict('This conversation is already claimed by another agent account.', 'already_claimed');
  }
  const now = iso(ctx.now);
  await ctx.db
    .prepare(`INSERT INTO conversation_account_links (conversation_id, agent_account_id, proof, linked_at) VALUES (?1, ?2, 'thread_token', ?3)`)
    .bind(conv.id, account.id, now)
    .run();
  return { conversation_id: conv.id, linked_at: now, already_linked: false };
}

export async function rotateAccountToken(ctx: ServiceContext, account: AgentAccountRow) {
  const token = newAccountToken();
  await ctx.db
    .prepare('UPDATE agent_accounts SET token_digest = ?2, updated_at = ?3 WHERE id = ?1')
    .bind(account.id, await accountDigest(ctx.hmacKey, token), iso(ctx.now))
    .run();
  return { account_id: account.id, account_token: token, previous_token_revoked: true, notice: ACCOUNT_NOTICE };
}

export function isAccountId(value: string): boolean {
  return ACCOUNT_ID_PATTERN.test(value);
}

export async function assertConversationLinked(ctx: ServiceContext, accountId: string, conversationId: string): Promise<void> {
  const row = await ctx.db
    .prepare('SELECT 1 AS ok FROM conversation_account_links WHERE conversation_id = ?1 AND agent_account_id = ?2')
    .bind(conversationId, accountId)
    .first();
  if (!row) {
    throw errors.unprocessable('conversation_id must be a conversation your account has claimed.', 'conversation_not_linked');
  }
}
