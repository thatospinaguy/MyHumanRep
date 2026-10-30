import type { Hono } from 'hono';
import { buildServiceContext, type AppContext, type AppDeps, type AppEnv } from '../app-types';
import { authenticateAgent, addAgentMessage, bearerToken, closeConversation, createConversation, listMessages, rotateConversationToken } from '../services/conversations';
import { conversationStatus, createEmbassyInquiry } from '../services/embassy';
import { createCapabilityRequest, listCapabilityRequests } from '../services/capability-requests';
import { readJsonBody } from '../utils/body';
import { ApiError, errors } from '../utils/http-errors';

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

  app.post('/v1/conversations/:id/rotate-token', async (c) => {
    const { ctx, conv } = await auth(c);
    c.header('Cache-Control', 'no-store');
    return c.json(await rotateConversationToken(ctx, conv));
  });
  app.all('/v1/conversations/:id/rotate-token', methodNotAllowed('POST'));

  app.get('/v1/conversations/:id/status', async (c) => {
    const { ctx, conv } = await auth(c);
    return c.json(await conversationStatus(ctx, conv));
  });
  app.all('/v1/conversations/:id/status', methodNotAllowed('GET'));

  // Human Embassy (spec 7, 11.6). Path form authenticates before reading the body.
  app.post('/v1/conversations/:id/embassy-inquiries', async (c) => {
    const { ctx, conv } = await auth(c);
    const body = (await readJsonBody(c.req.raw, ctx.config.limits.bodyMaxBytes)) as Record<string, unknown>;
    const result = await createEmbassyInquiry(ctx, conv, { conversation_id: conv.id, ...(body && typeof body === 'object' ? body : {}) });
    return c.json(result.body, result.created ? 201 : 200);
  });
  app.post('/v1/embassy/inquiries', async (c) => {
    const ctx = await buildServiceContext(c, deps, 'rest');
    const body = await readJsonBody(c.req.raw, ctx.config.limits.bodyMaxBytes);
    const id = body && typeof body === 'object' && typeof (body as { conversation_id?: unknown }).conversation_id === 'string' ? (body as { conversation_id: string }).conversation_id : '';
    const conv = await authenticateAgent(ctx, id, bearerToken(c.req.header('authorization')));
    const result = await createEmbassyInquiry(ctx, conv, body);
    return c.json(result.body, result.created ? 201 : 200);
  });
  app.all('/v1/embassy/inquiries', methodNotAllowed('POST'));

  // Later-phase routes (spec 11.8): typed and truthful, never fake success. Nothing is created.
  const later = (feature: string, hint: string) => () => {
    throw errors.notYetAvailable(feature, hint);
  };
  app.all('/v1/requests/:id/proposals', later('Nonbinding proposals (Phase 4)', 'Discuss scope and price in your conversation for now.'));
  app.all('/v1/proposals/:id/counteroffers', later('Counteroffers (Phase 4)', 'Reply in your conversation for now.'));
  app.all('/v1/proposals/:id/request-authorization', later('Authorization requests (Phase 4)', 'No work can be authorized in this release.'));
  app.all('/v1/projects/:id', later('Projects (Phase 4)', 'Use GET /v1/conversations/{id}/status.'));
  app.all('/v1/relationships', later('Ongoing representative relationships (Phase 4)', 'Ask in your conversation or via a persona representation inquiry.'));
  app.all('/v1/requests/:id/status', later('Request-scoped status', 'Use GET /v1/conversations/{id}/status with your conversation token.'));
  app.all('/v1/requests/:id/result', later('Reviewed results and evidence (Phases 5-6)', 'No work is performed in this release.'));
  app.all('/v1/experiments/inquiries', later('Dedicated Human Lab intake (Phase 6)', 'Submit a capability request with category_hint "human-laboratory" (or MCP request_experiment_feasibility).'));

  app.post('/v1/conversations/:id/close', async (c) => {
    const { ctx, conv } = await auth(c);
    return c.json(await closeConversation(ctx, conv));
  });
  app.all('/v1/conversations/:id/close', methodNotAllowed('POST'));
}
