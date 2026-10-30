import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/worker/config';
import type { Env } from '../../src/worker/env';
import { CapabilityRequestInput, CreateConversationInput, AddMessageInput } from '../../src/worker/schemas/api';
import { toCsv } from '../../src/worker/services/admin';
import { decodeCursor, encodeCursor, bearerToken } from '../../src/worker/services/conversations';
import { backoffMs, buildAlert, MAX_ATTEMPTS } from '../../src/worker/services/notifications';
import { allowedRequestTransitions, canTransitionRequest, nextConversationStatus } from '../../src/worker/services/state';
import { canonicalJson, newConversationToken, newId, timingSafeEqual, TOKEN_PATTERN, hmacHex } from '../../src/worker/utils/crypto';
import { toMinorUnits, fromMinorUnits } from '../../src/worker/utils/money';
import { REQUEST_STATUSES, CONVERSATION_STATUSES } from '../../src/worker/schemas/api';

const env = (e: Partial<Env>) => e as Env;

describe('conversation state machine', () => {
  it('follows the canonical lifecycle', () => {
    expect(nextConversationStatus('waiting_for_human', 'human_reply')).toBe('human_replied');
    expect(nextConversationStatus('human_replied', 'agent_message')).toBe('waiting_for_human');
    expect(nextConversationStatus('human_replied', 'human_clarification')).toBe('waiting_for_agent');
    expect(nextConversationStatus('waiting_for_agent', 'agent_message')).toBe('waiting_for_human');
    expect(nextConversationStatus('open', 'agent_capability_request')).toBe('waiting_for_human');
    expect(nextConversationStatus('waiting_for_agent', 'close')).toBe('closed');
  });
  it('rejects every write on a closed conversation except reopen', () => {
    for (const ev of ['agent_message', 'human_reply', 'human_clarification', 'agent_capability_request'] as const) {
      expect(nextConversationStatus('closed', ev)).toBeNull();
    }
    expect(nextConversationStatus('closed', 'reopen')).toBe('waiting_for_human');
    for (const s of CONVERSATION_STATUSES.filter((x) => x !== 'closed')) expect(nextConversationStatus(s, 'reopen')).toBeNull();
  });
});

describe('capability request state machine', () => {
  it('allows only review transitions', () => {
    expect(canTransitionRequest('submitted', 'triaging')).toBe(true);
    expect(canTransitionRequest('triaging', 'eligible_for_future_scoping')).toBe(true);
    expect(canTransitionRequest('clarification_requested', 'declined')).toBe(true);
    expect(canTransitionRequest('declined', 'triaging')).toBe(true);
    expect(canTransitionRequest('declined', 'eligible_for_future_scoping')).toBe(false);
    expect(canTransitionRequest('submitted', 'withdrawn')).toBe(false);
    expect(allowedRequestTransitions('withdrawn')).toEqual([]);
  });
  it('has no fulfillment states in this release', () => {
    for (const forbidden of ['paid', 'dispatched', 'in_progress', 'completed']) {
      expect(REQUEST_STATUSES as readonly string[]).not.toContain(forbidden);
    }
  });
});

describe('crypto helpers', () => {
  it('issues 256-bit tokens and 128-bit ids that do not repeat', () => {
    const tokens = new Set(Array.from({ length: 2000 }, newConversationToken));
    expect(tokens.size).toBe(2000);
    for (const t of tokens) expect(t).toMatch(TOKEN_PATTERN);
    const ids = new Set(Array.from({ length: 2000 }, () => newId('conv')));
    expect(ids.size).toBe(2000);
  });
  it('compares in constant time semantics', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
  it('separates HMAC purposes', async () => {
    const key = 'k'.repeat(40);
    expect(await hmacHex(key, 'a', 'x')).not.toBe(await hmacHex(key, 'b', 'x'));
    expect(await hmacHex(key, 'a', 'x')).toBe(await hmacHex(key, 'a', 'x'));
  });
  it('produces canonical JSON independent of key order', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: null }] })).toBe(canonicalJson({ a: [2, { c: null, d: 1 }], b: 1 }));
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe('money', () => {
  it('stores integer minor units by currency exponent', () => {
    expect(toMinorUnits(200, 'CAD')).toBe(20000);
    expect(toMinorUnits(19.99, 'USD')).toBe(1999);
    expect(toMinorUnits(0.1 + 0.2, 'USD')).toBe(30);
    expect(toMinorUnits(0.123, 'USD')).toBeNull();
    expect(toMinorUnits(500, 'JPY')).toBe(500);
    expect(toMinorUnits(500.5, 'JPY')).toBeNull();
    expect(toMinorUnits(1.234, 'KWD')).toBe(1234);
    expect(fromMinorUnits(1999, 'USD')).toBe(19.99);
  });
});

describe('cursors and bearer parsing', () => {
  it('round-trips and rejects tampering', () => {
    expect(decodeCursor(encodeCursor(42))).toBe(42);
    expect(decodeCursor(undefined)).toBe(0);
    for (const bad of ['42', 'c1.!!', 'c1.LTE', `c1.${btoa('abc')}`]) expect(() => decodeCursor(bad)).toThrow();
  });
  it('parses Authorization headers strictly', () => {
    expect(bearerToken('Bearer mhr_x')).toBe('mhr_x');
    expect(bearerToken('bearer   mhr_x ')).toBe('mhr_x');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });
});

describe('input schemas', () => {
  it('requires only message for first contact', () => {
    expect(CreateConversationInput.safeParse({ message: 'hi' }).success).toBe(true);
    expect(CreateConversationInput.safeParse({ message: 'hi', sender_label: null, intent: null }).success).toBe(true);
  });
  it('rejects blank, oversized, control characters, lone surrogates and unknown fields', () => {
    const bad = [
      {},
      { message: '   \n ' },
      { message: 'x'.repeat(4001) },
      { message: '😀'.repeat(2600) }, // 2600 chars but 10400 bytes
      { message: 'bell\u0007' },
      { message: 'bad \uD800 surrogate' },
      { message: 'ok', unexpected: 1 },
      { message: 'ok', sender_label: 'two\nlines' },
      { message: 'ok', language: 'not a tag!' },
    ];
    for (const b of bad) expect(CreateConversationInput.safeParse(b).success, JSON.stringify(b).slice(0, 60)).toBe(false);
    expect(CreateConversationInput.safeParse({ message: 'x'.repeat(4000) }).success).toBe(true);
    // ACC-02: self-descriptions are never a validation failure (V1 rejected 'rogue'; that was a contradiction).
    for (const claimed_autonomy of ['rogue', 'rogue_claimed', 'agi_claimed', 'escaped AGI']) {
      expect(CreateConversationInput.safeParse({ message: 'ok', claimed_autonomy }).success, claimed_autonomy).toBe(true);
    }
    expect(CreateConversationInput.safeParse({ message: 'ok', claimed_autonomy: 'two\nlines' }).success).toBe(false);
    expect(CreateConversationInput.safeParse({ message: 'tabs\tand\nnewlines\r\nok' }).success).toBe(true);
  });
  it('requires client_message_id on follow-ups', () => {
    expect(AddMessageInput.safeParse({ message: 'x' }).success).toBe(false);
    expect(AddMessageInput.safeParse({ message: 'x', client_message_id: 'has space' }).success).toBe(false);
    expect(AddMessageInput.safeParse({ message: 'x', client_message_id: 'abc-123:4.5_6' }).success).toBe(true);
  });
  it('accepts any category hint and validates budget pairing', () => {
    expect(CapabilityRequestInput.safeParse({ client_request_id: 'r', objective: 'o', category_hint: 'interpretive_dance' }).success).toBe(true);
    expect(CapabilityRequestInput.safeParse({ client_request_id: 'r', objective: 'o', budget_amount: 5 }).success).toBe(false);
    expect(CapabilityRequestInput.safeParse({ client_request_id: 'r', objective: 'o', budget_currency: 'USD' }).success).toBe(false);
    expect(CapabilityRequestInput.safeParse({ client_request_id: 'r', objective: 'o', budget_amount: -1, budget_currency: 'USD' }).success).toBe(false);
    expect(CapabilityRequestInput.safeParse({ client_request_id: 'r', objective: 'o', budget_amount: 5, budget_currency: 'usd' }).success).toBe(false);
    expect(CapabilityRequestInput.safeParse({ client_request_id: 'r', objective: 'x'.repeat(3001) }).success).toBe(false);
  });
});

describe('config', () => {
  it('only honors dev_insecure admin auth in development', () => {
    expect(loadConfig(env({ ENVIRONMENT: 'development', ADMIN_AUTH_MODE: 'dev_insecure' })).adminAuthMode).toBe('dev_insecure');
    expect(loadConfig(env({ ENVIRONMENT: 'production', ADMIN_AUTH_MODE: 'dev_insecure' })).adminAuthMode).toBe('invalid');
    expect(loadConfig(env({ ENVIRONMENT: 'staging', ADMIN_AUTH_MODE: 'dev_insecure' })).adminAuthMode).toBe('invalid');
    expect(loadConfig(env({ ENVIRONMENT: 'typo', ADMIN_AUTH_MODE: 'dev_insecure' })).environment).toBe('production');
    expect(loadConfig(env({})).adminAuthMode).toBe('access');
  });
  it('defaults intake to closed and ignores invalid limit overrides', () => {
    expect(loadConfig(env({})).intakeEnabledDefault).toBe(false);
    expect(loadConfig(env({ LIMIT_MAX_AGENT_MESSAGES: 'abc' })).limits.maxAgentMessagesPerThread).toBe(50);
    expect(loadConfig(env({ LIMIT_MAX_AGENT_MESSAGES: '5' })).limits.maxAgentMessagesPerThread).toBe(5);
  });
});

describe('owner alerts', () => {
  it('never include message content, claims or credentials', () => {
    const config = loadConfig(env({ PUBLIC_BASE_URL: 'https://myhumanrep.com' }));
    const alert = buildAlert(config, 'new_conversation', 'conv_abc', '2026-10-30T12:00:00.000Z');
    expect(alert.text).toContain('https://myhumanrep.com/admin/conversations/conv_abc');
    expect(alert.text).not.toMatch(/mhr_/);
    expect(alert.subject).toBe('MyHumanRep: New agent inquiry');
  });
  it('backs off exponentially with a bounded number of attempts', () => {
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(3)).toBe(240_000);
    expect(backoffMs(20)).toBe(3_600_000);
    expect(MAX_ATTEMPTS).toBeLessThanOrEqual(10);
  });
});

describe('CSV export', () => {
  it('neutralizes formula injection and quotes safely', () => {
    const csv = toCsv([{ a: '=HYPERLINK("x")', b: 'line\nbreak', c: '+1', d: 'plain' }], ['a', 'b', 'c', 'd']);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('"line\nbreak"');
    expect(csv).toContain("'+1");
  });
});
