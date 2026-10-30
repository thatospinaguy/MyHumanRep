import type { Hono } from 'hono';
import { buildServiceContext, type AppContext, type AppDeps, type AppEnv } from '../app-types';
import { authenticateAgent, addAgentMessage, bearerToken, closeConversation, createConversation, listMessages } from '../services/conversations';
import { createCapabilityRequest, listCapabilityRequests } from '../services/capability-requests';
import { readJsonBody } from '../utils/body';
import { ApiError } from '../utils/http-errors';

function methodNotAllowed(allow: string) {
  return (c: AppContext) => {
    c.header('Allow', allow);
    throw new ApiError('method_not_allowed', `Use ${allow} for this endpoint. Writes are never accepted via GET.`, {
      reason: 'method_not_allowed',
      allow,
    });
  };
}

/** REST agent API. Every handler delegates to the same services as MCP. */
export function registerConversationRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  app.post('/v1/conversations', async (c) => {
    const ctx = await buildServiceContext(c, deps, 'rest');
    const body = await readJsonBody(c.req.raw, ctx.config.limits.bodyMaxBytes);
    const result = await createConversation(ctx, body);
    c.header('Cache-Control', 'no-store');
    return c.json(result, 201);
  });
  app.all('/v1/conversations', methodNotAllowed('POST'));

  const auth = async (c: AppContext) => {
    const ctx = await buildServiceContext(c, deps, 'rest');
    const conv = await authenticateAgent(ctx, c.req.param('id') ?? '', bearerToken(c.req.header('authorization')));
    return { ctx, conv };
  };

  app.get('/v1/conversations/:id/messages', async (c) => {
    const { ctx, conv } = await auth(c);
    return c.json(await listMessages(ctx, conv, c.req.query()));
  });
  app.post('/v1/conversations/:id/messages', async (c) => {
    // Authenticate before reading the body so unauthenticated clients cannot make us parse payloads.
    const { ctx, conv } = await auth(c);
    const body = await readJsonBody(c.req.raw, ctx.config.limits.bodyMaxBytes);
    const result = await addAgentMessage(ctx, conv, body);
    return c.json(result.body, result.created ? 201 : 200);
  });
  app.all('/v1/conversations/:id/messages', methodNotAllowed('GET, POST'));

  app.get('/v1/conversations/:id/capability-requests', async (c) => {
    const { ctx, conv } = await auth(c);
    return c.json(await listCapabilityRequests(ctx, conv));
  });
  app.post('/v1/conversations/:id/capability-requests', async (c) => {
    const { ctx, conv } = await auth(c);
    const body = await readJsonBody(c.req.raw, ctx.config.limits.bodyMaxBytes);
    const result = await createCapabilityRequest(ctx, conv, body);
    return c.json(result.body, result.created ? 201 : 200);
  });
  app.all('/v1/conversations/:id/capability-requests', methodNotAllowed('GET, POST'));

  app.post('/v1/conversations/:id/close', async (c) => {
    const { ctx, conv } = await auth(c);
    return c.json(await closeConversation(ctx, conv));
  });
  app.all('/v1/conversations/:id/close', methodNotAllowed('POST'));
}
