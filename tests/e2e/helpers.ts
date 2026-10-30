import type { APIRequestContext } from '@playwright/test';

let n = 0;
/** Distinct client source per call so per-source quotas never interfere between tests. */
export function ip(): string {
  n++;
  return `198.18.${Math.floor(n / 250)}.${n % 250}`;
}

export async function agentStart(request: APIRequestContext, body: Record<string, unknown>) {
  const res = await request.post('/v1/conversations', { data: body, headers: { 'cf-connecting-ip': ip() } });
  if (res.status() !== 201) throw new Error(`start failed: ${res.status()} ${await res.text()}`);
  const json = (await res.json()) as { conversation_id: string; conversation_token: string };
  return { id: json.conversation_id, token: json.conversation_token, headers: { authorization: `Bearer ${json.conversation_token}` } };
}
