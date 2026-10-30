import type { Context } from 'hono';
import type { JWTVerifyGetKey } from 'jose';
import type { Config } from './config';
import type { Env } from './env';
import type { AdminIdentity } from './middleware/admin-auth';
import { requireHmacKey, sourceDigestFor, type Interface, type ServiceContext } from './services/context';
import { createMailer, type Mailer } from './services/notifications';

export interface AppVariables {
  requestId: string;
  config: Config;
  now: Date;
  admin: AdminIdentity;
}

export type AppEnv = { Bindings: Env; Variables: AppVariables };
export type AppContext = Context<AppEnv>;

/** Injection points for tests. Production uses the defaults. */
export interface AppDeps {
  now?: () => Date;
  accessKeyResolver?: JWTVerifyGetKey;
  mailer?: Mailer;
}

export function waitUntilOf(c: AppContext): (p: Promise<unknown>) => void {
  try {
    const ctx = c.executionCtx;
    return (p) => ctx.waitUntil(p);
  } catch {
    return (p) => {
      void p.catch(() => undefined);
    };
  }
}

export function mailerFor(c: AppContext, deps: AppDeps): Mailer {
  return deps.mailer ?? createMailer(c.env, c.get('config'));
}

export async function buildServiceContext(c: AppContext, deps: AppDeps, via: Interface): Promise<ServiceContext> {
  const hmacKey = requireHmacKey(c.env);
  const now = c.get('now');
  return {
    env: c.env,
    config: c.get('config'),
    db: c.env.MHR_DB,
    now,
    requestId: c.get('requestId'),
    via,
    sourceDigest: await sourceDigestFor(c.req.raw, hmacKey, now),
    hmacKey,
    waitUntil: waitUntilOf(c),
    mailer: mailerFor(c, deps),
  };
}
