import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/worker/config';
import type { Env } from '../../src/worker/env';
import { clarifyRequest, patchRequest, replyToConversation, type AdminContext } from '../../src/worker/services/admin';
import { ApiError } from '../../src/worker/utils/http-errors';
import { json, makeHarness, startConversation } from '../helpers';

/** D1 wrapper that closes the conversation right before the admin's batch executes. */
function racingDb(conversationId: string): D1Database {
  const db = env.MHR_DB;
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          await db
            .prepare("UPDATE conversations SET status = 'closed', closed_at = ?2, closed_by = 'agent' WHERE id = ?1")
            .bind(conversationId, new Date().toISOString())
            .run();
          return db.batch(statements);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('admin writes racing an agent close', () => {
  it('reject the write and leave the conversation consistently closed', async () => {
    const h = await makeHarness();
    const c = await startConversation(h);
    const cap = await json(
      await h.fetch(`/v1/conversations/${c.conversation_id}/capability-requests`, {
        method: 'POST',
        headers: c.auth,
        json: { client_request_id: 'r', objective: 'o' },
      }),
    );
    const ctx: AdminContext = {
      db: racingDb(c.conversation_id),
      config: loadConfig({ ...env, ...h.envOverrides } as unknown as Env),
      now: h.clock.now(),
      actor: 'owner@example.com',
      requestId: 'req_test',
    };
    const attempts: Array<() => Promise<unknown>> = [
      () => replyToConversation(ctx, c.conversation_id, { message: 'late reply' }),
      () => clarifyRequest(ctx, cap.request_id, { question: 'late question' }),
      () => patchRequest(ctx, cap.request_id, { status: 'triaging', message_to_agent: 'late decision' }),
    ];
    for (const attempt of attempts) {
      // Reset to open so each attempt passes the pre-check and loses the race inside the batch.
      await env.MHR_DB.prepare("UPDATE conversations SET status = 'waiting_for_human', closed_at = NULL, closed_by = NULL WHERE id = ?1")
        .bind(c.conversation_id)
        .run();
      const err = await attempt().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(409);
      expect((err as ApiError).details?.reason).toBe('conversation_closed');
    }

    const conv = await env.MHR_DB.prepare('SELECT status, closed_at, human_message_count FROM conversations WHERE id = ?1')
      .bind(c.conversation_id)
      .first<{ status: string; closed_at: string | null; human_message_count: number }>();
    expect(conv?.status).toBe('closed');
    expect(conv?.closed_at).not.toBeNull();
    expect(conv?.human_message_count).toBe(0);
    const humans = await env.MHR_DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE sender = 'human'").first<{ n: number }>();
    expect(humans?.n).toBe(0);
    const req = await env.MHR_DB.prepare('SELECT status FROM capability_requests WHERE id = ?1').bind(cap.request_id).first<{ status: string }>();
    expect(req?.status).toBe('submitted');
    const audit = await env.MHR_DB.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action IN ('conversation.reply','capability_request.clarify','capability_request.update')").first<{ n: number }>();
    expect(audit?.n).toBe(0);
  });
});
