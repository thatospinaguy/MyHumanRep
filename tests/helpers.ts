import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet, type JWTVerifyGetKey } from 'jose';
import { createApp } from '../src/worker/app';
import type { AppDeps } from '../src/worker/app-types';
import type { Env } from '../src/worker/env';
import type { Mailer, OwnerAlert } from '../src/worker/services/notifications';
import { MailError } from '../src/worker/services/notifications';

export const BASE = 'http://localhost:8787';

export class Clock {
  constructor(public current: Date = new Date('2026-10-30T12:00:00.000Z')) {}
  now = () => new Date(this.current.getTime());
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class FakeMailer implements Mailer {
  readonly provider = 'log' as const;
  sent: OwnerAlert[] = [];
  failuresRemaining = 0;
  failRetryable = true;
  async send(alert: OwnerAlert): Promise<void> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining--;
      throw new MailError('test_failure', this.failRetryable);
    }
    this.sent.push(alert);
  }
}

export const ACCESS_TEAM = 'https://test-team.cloudflareaccess.com';
export const ACCESS_AUD = 'test-aud-tag';
export const OWNER = 'owner@example.com';

export interface AccessKeys {
  resolver: JWTVerifyGetKey;
  sign: (claims?: Record<string, unknown>, opts?: { exp?: string | number; aud?: string; iss?: string }) => Promise<string>;
  signWithOtherKey: () => Promise<string>;
}

export async function makeAccessKeys(): Promise<AccessKeys> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-kid', alg: 'RS256', use: 'sig' };
  const resolver = createLocalJWKSet({ keys: [jwk] });
  const sign = async (claims: Record<string, unknown> = {}, opts: { exp?: string | number; aud?: string; iss?: string } = {}) =>
    new SignJWT({ email: OWNER, ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setIssuer(opts.iss ?? ACCESS_TEAM)
      .setAudience(opts.aud ?? ACCESS_AUD)
      .setSubject('user-123')
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? '5m')
      .sign(privateKey);
  const other = await generateKeyPair('RS256');
  const signWithOtherKey = () =>
    new SignJWT({ email: OWNER })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setIssuer(ACCESS_TEAM)
      .setAudience(ACCESS_AUD)
      .setSubject('user-123')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(other.privateKey);
  return { resolver, sign, signWithOtherKey };
}

/** Access-mode admin configuration (the production posture). */
export const ACCESS_ENV: Partial<Env> = {
  ENVIRONMENT: 'production',
  PUBLIC_BASE_URL: 'https://myhumanrep.test',
  ADMIN_AUTH_MODE: 'access',
  ACCESS_TEAM_DOMAIN: ACCESS_TEAM,
  ACCESS_AUD: ACCESS_AUD,
  ADMIN_EMAILS: OWNER,
  INTAKE_ENABLED: 'true',
};

export interface Harness {
  clock: Clock;
  mailer: FakeMailer;
  keys: AccessKeys;
  envOverrides: Partial<Env>;
  fetch: (path: string, init?: RequestInit & { json?: unknown; base?: string }) => Promise<Response>;
  /** Admin API call authenticated with a valid Access assertion. */
  admin: (path: string, init?: RequestInit & { json?: unknown }) => Promise<Response>;
}

export async function makeHarness(opts: { env?: Partial<Env>; deps?: AppDeps } = {}): Promise<Harness> {
  const clock = new Clock();
  const mailer = new FakeMailer();
  const keys = await makeAccessKeys();
  const envOverrides: Partial<Env> = { ...ACCESS_ENV, ...opts.env };
  const app = createApp({ now: clock.now, mailer, accessKeyResolver: keys.resolver, ...opts.deps });

  const doFetch: Harness['fetch'] = async (path, init = {}) => {
    const { json, base, ...rest } = init;
    const headers = new Headers(rest.headers);
    let body = rest.body;
    if (json !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(json);
    }
    const origin = base ?? envOverrides.PUBLIC_BASE_URL ?? BASE;
    const request = new Request(`${origin}${path}`, { ...rest, headers, body });
    const ctx = createExecutionContext();
    // Edge rate limiter disabled by default so app-level quotas are tested deterministically.
    const testEnv = { ...env, RL_PUBLIC: undefined, ...envOverrides } as unknown as Env;
    const res = await app.fetch(request, testEnv, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };

  const admin: Harness['admin'] = async (path, init = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has('cf-access-jwt-assertion')) headers.set('cf-access-jwt-assertion', await keys.sign());
    headers.set('x-mhr-admin', '1');
    return doFetch(path, { ...init, headers });
  };

  return { clock, mailer, keys, envOverrides, fetch: doFetch, admin };
}

export async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

let counter = 0;
/** Unique-per-test source address so per-source quotas never collide across tests. */
export function freshIp(): string {
  counter++;
  return `203.0.113.${counter % 250}`.concat(`-${Date.now()}-${counter}`);
}

export async function startConversation(h: Harness, body: Record<string, unknown> = {}, ip = freshIp()) {
  const res = await h.fetch('/v1/conversations', {
    method: 'POST',
    json: { message: 'Hello, I would like to talk to a human.', ...body },
    headers: { 'cf-connecting-ip': ip },
  });
  if (res.status !== 201) throw new Error(`start failed ${res.status}: ${await res.text()}`);
  const data = await json<{ conversation_id: string; conversation_token: string; first_message_id: string }>(res);
  return { ...data, auth: { authorization: `Bearer ${data.conversation_token}` } };
}
