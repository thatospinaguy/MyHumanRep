import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../../src/worker/index';
import { loadConfig } from '../../src/worker/config';
import type { Env } from '../../src/worker/env';
import { MAX_ATTEMPTS, processOutbox } from '../../src/worker/services/notifications';
import { runRetention } from '../../src/worker/services/retention';
import { DAY, MINUTE } from '../../src/worker/utils/time';
import { ACCESS_ENV, json, makeHarness, startConversation } from '../helpers';

const outbox = async () =>
  (await env.MHR_DB.prepare('SELECT * FROM notification_outbox ORDER BY created_at').all<Record<string, unknown>>()).results;

describe('owner notifications', () => {
  it('enqueues alerts for first contact, follow-ups and requests, delivered without content', async () => {
    const h = await makeHarness();
    const c = await startConversation(h, { message: 'BODY-SHOULD-NOT-BE-EMAILED' });
    expect(h.mailer.sent).toHaveLength(1);
    expect(h.mailer.sent[0]!.subject).toBe('MyHumanRep: New agent inquiry');
    await h.fetch(`/v1/conversations/${c.conversation_id}/messages`, {
      method: 'POST',
      headers: c.auth,
      json: { message: 'follow', client_message_id: '1' },
    });
    await h.fetch(`/v1/conversations/${c.conversation_id}/capability-requests`, {
      method: 'POST',
      headers: c.auth,
      json: { client_request_id: 'r', objective: 'o' },
    });
    expect(h.mailer.sent.map((m) => m.subject)).toEqual([
      'MyHumanRep: New agent inquiry',
      'MyHumanRep: New agent follow-up message',
      'MyHumanRep: New human capability request',
    ]);
    const all = JSON.stringify(h.mailer.sent);
    expect(all).not.toContain('BODY-SHOULD-NOT-BE-EMAILED');
    expect(all).not.toContain(c.conversation_token);
    expect(all).toContain(`https://myhumanrep.test/admin/conversations/${c.conversation_id}`);
  });

  it('retries transient failures with backoff and never rolls back the inbound message', async () => {
    const h = await makeHarness();
    h.mailer.failuresRemaining = 2;
    const c = await startConversation(h);
    // Conversation exists despite the mail failure.
    expect((await h.fetch(`/v1/conversations/${c.conversation_id}/messages`, { headers: c.auth })).status).toBe(200);
    let [row] = await outbox();
    expect(row).toMatchObject({ status: 'pending', attempts: 1, last_error_code: 'test_failure' });

    const config = loadConfig({ ...env, ...h.envOverrides } as unknown as Env);
    // Not yet due: nothing happens.
    expect((await processOutbox(env.MHR_DB, config, h.mailer, h.clock.now())).failed).toBe(0);
    h.clock.advance(MINUTE + 1000);
    expect((await processOutbox(env.MHR_DB, config, h.mailer, h.clock.now())).failed).toBe(1);
    h.clock.advance(2 * MINUTE + 1000);
    expect((await processOutbox(env.MHR_DB, config, h.mailer, h.clock.now())).sent).toBe(1);
    [row] = await outbox();
    expect(row).toMatchObject({ status: 'sent', attempts: 3 });
    expect(h.mailer.sent).toHaveLength(1);
  });

  it('dead-letters after bounded attempts and surfaces it in metrics', async () => {
    const h = await makeHarness();
    h.mailer.failuresRemaining = 100;
    await startConversation(h);
    const config = loadConfig({ ...env, ...h.envOverrides } as unknown as Env);
    for (let i = 0; i < 20; i++) {
      h.clock.advance(61 * MINUTE);
      await processOutbox(env.MHR_DB, config, h.mailer, h.clock.now());
    }
    const [row] = await outbox();
    expect(row).toMatchObject({ status: 'dead', attempts: MAX_ATTEMPTS });
    const m = await json(await h.admin('/admin/api/metrics'));
    expect(m.observed.notifications_by_status.dead).toBe(1);
  });

  it('does not retry non-retryable failures', async () => {
    const h = await makeHarness();
    h.mailer.failuresRemaining = 1;
    h.mailer.failRetryable = false;
    await startConversation(h);
    const [row] = await outbox();
    expect(row).toMatchObject({ status: 'dead', attempts: 1 });
  });

  it('suppresses alerts for blocked threads instead of retrying forever', async () => {
    const h = await makeHarness();
    h.mailer.failuresRemaining = 1;
    const c = await startConversation(h);
    await h.admin(`/admin/api/conversations/${c.conversation_id}`, { method: 'PATCH', json: { action: 'block' } });
    const [row] = await outbox();
    expect(row!.status).toBe('suppressed');
    const config = loadConfig({ ...env, ...h.envOverrides } as unknown as Env);
    h.clock.advance(DAY);
    const result = await processOutbox(env.MHR_DB, config, h.mailer, h.clock.now());
    expect(result).toEqual({ sent: 0, failed: 0, dead: 0, suppressed: 0, disabled: 0 });
  });

  it('coalesces a burst of follow-ups into one pending alert', async () => {
    const h = await makeHarness();
    h.mailer.failuresRemaining = 100;
    const c = await startConversation(h);
    for (let i = 0; i < 5; i++) {
      await h.fetch(`/v1/conversations/${c.conversation_id}/messages`, {
        method: 'POST',
        headers: c.auth,
        json: { message: `m${i}`, client_message_id: `m${i}` },
      });
    }
    expect((await outbox()).filter((r) => r.status === 'pending')).toHaveLength(1);
  });

  it('marks alerts disabled when notifications are switched off', async () => {
    const h = await makeHarness();
    await h.admin('/admin/api/settings', { method: 'PATCH', json: { notifications_enabled: false } });
    await startConversation(h);
    const [row] = await outbox();
    expect(row!.status).toBe('disabled');
    expect(h.mailer.sent).toHaveLength(0);
  });

  it('drains the outbox and runs retention from the scheduled handler', async () => {
    const h = await makeHarness();
    h.mailer.failuresRemaining = 1;
    await startConversation(h);
    const testEnv = { ...env, ...ACCESS_ENV, NOTIFY_PROVIDER: 'log', RL_PUBLIC: undefined } as unknown as Env;
    const ctx = createExecutionContext();
    await worker.scheduled(
      createScheduledController({ scheduledTime: h.clock.current.getTime() + 10 * MINUTE, cron: '*/5 * * * *' }),
      testEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect((await outbox())[0]!.status).toBe('sent');

    const ctx2 = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: h.clock.current.getTime(), cron: '0 4 * * *' }), testEnv, ctx2);
    await waitOnExecutionContext(ctx2);
    const audit = await env.MHR_DB.prepare("SELECT * FROM admin_audit WHERE action = 'retention.run'").all();
    expect(audit.results).toHaveLength(1);
  });
});

describe('retention', () => {
  it('deletes expired conversations after the grace period, honoring holds and extensions', async () => {
    const h = await makeHarness();
    const old = await startConversation(h, { message: 'old' });
    const held = await startConversation(h, { message: 'held' });
    const extended = await startConversation(h, { message: 'extended' });
    await h.fetch(`/v1/conversations/${old.conversation_id}/capability-requests`, {
      method: 'POST',
      headers: old.auth,
      json: { client_request_id: 'r', objective: 'o' },
    });
    const holdRes = await h.admin(`/admin/api/conversations/${held.conversation_id}`, { method: 'PATCH', json: { retention_hold: true } });
    expect(holdRes.status, await holdRes.clone().text()).toBe(200);
    const extRes = await h.admin(`/admin/api/conversations/${extended.conversation_id}`, { method: 'PATCH', json: { extend_days: 30 } });
    expect(extRes.status, await extRes.clone().text()).toBe(200);
    h.clock.advance(5 * DAY);
    const fresh = await startConversation(h, { message: 'fresh' });

    const config = loadConfig({ ...env, ...h.envOverrides } as unknown as Env);
    // Expired but inside the 7-day grace window: kept.
    h.clock.advance(30 * DAY);
    expect((await runRetention(env.MHR_DB, config, h.clock.now())).conversations_deleted).toBe(0);
    // Past grace: only the unheld, unextended one is removed (with cascades).
    h.clock.advance(3 * DAY);
    const result = await runRetention(env.MHR_DB, config, h.clock.now());
    expect(result.conversations_deleted).toBe(1);
    const ids = (await env.MHR_DB.prepare('SELECT id FROM conversations').all<{ id: string }>()).results.map((r) => r.id).sort();
    expect(ids).toEqual([held.conversation_id, extended.conversation_id, fresh.conversation_id].sort());
    const orphans = await env.MHR_DB.prepare(
      'SELECT (SELECT COUNT(*) FROM messages WHERE conversation_id = ?1) + (SELECT COUNT(*) FROM capability_requests WHERE conversation_id = ?1) AS n',
    )
      .bind(old.conversation_id)
      .first<{ n: number }>();
    expect(orphans?.n).toBe(0);
  });

  it('purges short-lived abuse signals, counters and old audit records', async () => {
    const h = await makeHarness();
    await h.fetch('/v1/conversations', { method: 'POST', json: { message: '' } });
    await h.fetch('/v1/conversations/conv_AAAAAAAAAAAAAAAAAAAAAA/messages', { headers: { authorization: 'Bearer x' } });
    await startConversation(h);
    const abuseBefore = await env.MHR_DB.prepare('SELECT COUNT(*) AS n FROM abuse_events').first<{ n: number }>();
    expect(abuseBefore!.n).toBeGreaterThan(0);
    const config = loadConfig({ ...env, ...h.envOverrides } as unknown as Env);
    h.clock.advance(100 * DAY);
    const result = await runRetention(env.MHR_DB, config, h.clock.now());
    expect(result.abuse_events_deleted).toBe(abuseBefore!.n);
    expect(result.rate_limit_counters_deleted).toBeGreaterThan(0);
    const counters = await env.MHR_DB.prepare('SELECT COUNT(*) AS n FROM rate_limit_counters').first<{ n: number }>();
    expect(counters!.n).toBe(0);
  });

  it('publishes retention values that match the configured settings', async () => {
    const h = await makeHarness();
    await h.admin('/admin/api/settings', { method: 'PATCH', json: { conversation_ttl_days: 12, expired_grace_days: 3 } });
    const privacy = await (await h.fetch('/privacy')).text();
    expect(privacy).toContain('until 12 days after creation');
    expect(privacy).toContain('about 3 days');
    const caps = await json(await h.fetch('/v1/capabilities'));
    expect(caps.default_retention_days).toBe(12);
    const c = await startConversation(h);
    const read = await json(await h.fetch(`/v1/conversations/${c.conversation_id}/messages`, { headers: c.auth }));
    expect(Date.parse(read.expires_at) - h.clock.current.getTime()).toBe(12 * DAY);
  });
});
