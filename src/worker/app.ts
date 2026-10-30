import { Hono } from 'hono';
import type { AppDeps, AppEnv } from './app-types';
import { loadConfig } from './config';
import { applySecurityHeaders } from './middleware/security-headers';
import { NotFoundPage } from './pages/pages';
import { registerAdminRoutes } from './routes/admin';
import { registerConversationRoutes } from './routes/conversations';
import { registerHumanificationRoutes } from './routes/humanification';
import { registerMcpRoutes } from './routes/mcp';
import { registerPublicRoutes } from './routes/public';
import { newId } from './utils/crypto';
import { ApiError, errorBody } from './utils/http-errors';

/** Paths whose query strings may contain private data and must not survive a redirect. */
function isPrivatePath(path: string): boolean {
  return (
    path.startsWith('/admin') ||
    path.startsWith('/v1/conversations') ||
    path.startsWith('/v1/agent-accounts') ||
    path.startsWith('/v1/personas') ||
    path.startsWith('/v1/embassy') ||
    path.startsWith('/mcp')
  );
}

function redactPath(path: string): string {
  return path.replace(/\/(conv|cap|msg|per|acct|pinq|emb)_[A-Za-z0-9_-]+/g, '/$1_{id}').slice(0, 200);
}

const CORS_PATHS = /^\/(v1\/|openapi\.json$|health$|llms\.txt$|\.well-known\/myhumanrep\.json$)/;

export function createApp(deps: AppDeps = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    const started = Date.now();
    const config = loadConfig(c.env);
    c.set('config', config);
    c.set('requestId', newId('req'));
    c.set('now', deps.now ? deps.now() : new Date());

    const url = new URL(c.req.url);
    const host = url.hostname.toLowerCase();
    if (config.aliasHosts.includes(host)) {
      // Secondary domains redirect to the canonical host. Only safe, idempotent
      // public requests are redirected; private query strings are stripped.
      if (c.req.method === 'GET' || c.req.method === 'HEAD') {
        const target = new URL(url.pathname, config.baseUrl);
        if (!isPrivatePath(url.pathname)) target.search = url.search;
        c.res = applySecurityHeaders(new Response(null, { status: 301, headers: { Location: target.toString() } }), url.pathname, config);
        return;
      }
      c.res = applySecurityHeaders(
        Response.json(
          errorBody(
            new ApiError('invalid_request', `Use the canonical host ${config.baseUrl}.`, { reason: 'non_canonical_host' }),
            c.get('requestId'),
          ),
          { status: 400 },
        ),
        url.pathname,
        config,
      );
      return;
    }

    if (c.req.method === 'OPTIONS' && CORS_PATHS.test(url.pathname)) {
      c.res = new Response(null, { status: 204 });
    } else {
      await next();
    }

    // applySecurityHeaders returns a fresh Response with mutable headers.
    const res = applySecurityHeaders(c.res, url.pathname, config);
    if (CORS_PATHS.test(url.pathname)) {
      // Bearer tokens are never ambient (no cookies), so cross-origin agent clients are allowed.
      res.headers.set('Access-Control-Allow-Origin', '*');
      res.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.headers.set('Access-Control-Expose-Headers', 'Retry-After, X-Request-Id');
      res.headers.set('Access-Control-Max-Age', '600');
    }
    res.headers.set('X-Request-Id', c.get('requestId'));
    c.res = undefined;
    c.res = res;
    // Structured access log: no bodies, tokens, IPs or full IDs.
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'request',
        request_id: c.get('requestId'),
        method: c.req.method,
        path: redactPath(url.pathname),
        status: c.res.status,
        ms: Date.now() - started,
      }),
    );
  });

  registerPublicRoutes(app, deps);
  registerConversationRoutes(app, deps);
  registerHumanificationRoutes(app, deps);
  registerMcpRoutes(app, deps);
  registerAdminRoutes(app, deps);

  app.notFound((c) => {
    const path = c.req.path;
    if (path.startsWith('/v1/') || path.startsWith('/admin/api/') || path === '/mcp') {
      return c.json(errorBody(new ApiError('not_found', 'Not found.'), c.get('requestId')), 404);
    }
    return c.html(`<!DOCTYPE html>${NotFoundPage({ config: c.get('config'), path }).toString()}`, 404);
  });

  app.onError((err, c) => {
    const requestId = c.get('requestId') ?? 'unknown';
    if (err instanceof ApiError) {
      if (err.code === 'rate_limited') c.header('Retry-After', String(err.details?.retry_after_seconds ?? 60));
      if (err.status === 401 && c.req.path.startsWith('/v1/')) c.header('WWW-Authenticate', 'Bearer realm="myhumanrep"');
      c.header('Cache-Control', 'no-store');
      return c.json(errorBody(err, requestId), err.status as 400);
    }
    console.log(
      JSON.stringify({
        level: 'error',
        event: 'unhandled_error',
        request_id: requestId,
        error: err instanceof Error ? err.name : 'unknown',
        message: err instanceof Error ? err.message.slice(0, 200) : undefined,
      }),
    );
    c.header('Cache-Control', 'no-store');
    return c.json(errorBody(new ApiError('internal_error', 'Internal error. Try again later.'), requestId), 500);
  });

  return app;
}
