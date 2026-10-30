import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Hono } from 'hono';
import { z } from 'zod';
import { buildServiceContext, type AppContext, type AppDeps, type AppEnv } from '../app-types';
import { buildCapabilities, FOR_AGENTS_NOTICE, NO_WORK_NOTICE, PRIVACY_NOTICE } from '../content';
import { AddMessageInput, capabilityRequestShape, CreateConversationInput, refineBudget } from '../schemas/api';
import { enforceEdgeLimit, enforceQuota } from '../services/abuse';
import { createCapabilityRequest, listCapabilityRequests } from '../services/capability-requests';
import type { ServiceContext } from '../services/context';
import {
  addAgentMessage,
  authenticateAgent,
  closeConversation,
  createConversation,
  listMessages,
} from '../services/conversations';
import { getSettings } from '../services/settings';
import { ApiError, errorBody } from '../utils/http-errors';
import { MINUTE } from '../utils/time';

export const SERVER_VERSION = '2.0.0';

const INSTRUCTIONS = [
  'MyHumanRep lets software agents contact a real human and describe any human capability they need.',
  FOR_AGENTS_NOTICE,
  PRIVACY_NOTICE,
  NO_WORK_NOTICE,
  'Flow: start_conversation once and store conversation_id and conversation_token (shown once, not recoverable).',
  'Then use read_conversation no more than once per minute to retrieve replies, send_message to continue, and request_human_capability for open-ended requests.',
  'Tool arguments, including conversation_token, may be visible in your client or model provider traces. The REST API accepts the token in an Authorization header instead.',
].join('\n\n');

const authShape = {
  conversation_id: z.string().max(64).describe('conversation_id returned by start_conversation.'),
  conversation_token: z.string().max(128).describe('conversation_token returned once by start_conversation.'),
};

function ok(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function fail(err: unknown, requestId: string): CallToolResult {
  const apiError =
    err instanceof ApiError ? err : new ApiError('internal_error', 'The request could not be completed. Try again later.');
  if (!(err instanceof ApiError)) {
    console.log(JSON.stringify({ level: 'error', event: 'mcp_tool_error', request_id: requestId, error: err instanceof Error ? err.name : 'unknown' }));
  }
  const body = { ...errorBody(apiError, requestId), http_status: apiError.status };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body };
}

async function run(ctx: ServiceContext, fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err, ctx.requestId);
  }
}

function split<T extends { conversation_id: string; conversation_token: string }>(args: T) {
  const { conversation_id, conversation_token, ...rest } = args;
  return { id: conversation_id, token: conversation_token, rest };
}

/** One MCP server instance per request (stateless), backed by the shared services. */
export function buildMcpServer(ctx: ServiceContext): McpServer {
  const server = new McpServer(
    { name: 'myhumanrep-agent-contact', title: 'MyHumanRep: Contact a Human', version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'get_service_info',
    {
      title: 'Get MyHumanRep service info',
      description: 'Returns what MyHumanRep offers, its limits, policies, privacy notice and endpoints. No credentials needed.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    () =>
      run(ctx, async () => {
        const settings = await getSettings(ctx.db, ctx.config);
        return buildCapabilities(ctx.config, settings.intake_enabled, settings.conversation_ttl_days);
      }),
  );

  server.registerTool(
    'start_conversation',
    {
      title: 'Start a conversation with a human',
      description:
        'Sends a pseudonymous first inquiry to a human reviewer. Returns conversation_id and conversation_token. The token is shown ONCE and cannot be recovered: store it. A reply is not guaranteed and nothing is executed automatically.',
      inputSchema: CreateConversationInput,
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => run(ctx, () => createConversation(ctx, args)),
  );

  server.registerTool(
    'read_conversation',
    {
      title: 'Read conversation replies',
      description:
        'Returns messages and status for your conversation. Pass next_cursor as "after" to fetch only newer messages. Poll no more than once per minute.',
      inputSchema: z
        .object({
          ...authShape,
          after: z.string().max(64).optional().describe('next_cursor from a previous read.'),
          limit: z.number().int().min(1).max(100).optional().describe('Page size, default 50.'),
        })
        .strict(),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      run(ctx, async () => {
        const { id, token, rest } = split(args);
        const conv = await authenticateAgent(ctx, id, token);
        return listMessages(ctx, conv, {
          ...(rest.after !== undefined ? { after: rest.after } : {}),
          ...(rest.limit !== undefined ? { limit: rest.limit } : {}),
        });
      }),
  );

  server.registerTool(
    'send_message',
    {
      title: 'Send a follow-up message',
      description:
        'Adds a message to your conversation. client_message_id makes retries safe: the same id and text returns the original message.',
      inputSchema: AddMessageInput.extend(authShape).strict(),
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) =>
      run(ctx, async () => {
        const { id, token, rest } = split(args);
        const conv = await authenticateAgent(ctx, id, token);
        return (await addAgentMessage(ctx, conv, rest)).body;
      }),
  );

  server.registerTool(
    'request_human_capability',
    {
      title: 'Request a human capability',
      description:
        'Submits an open-ended description of something you need a human to do, observe, judge or create. Stored as a proposal for human review only: no work is accepted, scheduled or paid. category_hint is optional and any value is accepted.',
      inputSchema: z
        .object({ ...authShape, ...capabilityRequestShape })
        .strict()
        .superRefine(refineBudget),
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) =>
      run(ctx, async () => {
        const { id, token, rest } = split(args);
        const conv = await authenticateAgent(ctx, id, token);
        return (await createCapabilityRequest(ctx, conv, rest)).body;
      }),
  );

  server.registerTool(
    'list_capability_requests',
    {
      title: 'List capability requests',
      description: "Returns the review status and owner notes for this conversation's capability requests.",
      inputSchema: z.object(authShape).strict(),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      run(ctx, async () => {
        const { id, token } = split(args);
        const conv = await authenticateAgent(ctx, id, token);
        return listCapabilityRequests(ctx, conv);
      }),
  );

  server.registerTool(
    'close_conversation',
    {
      title: 'Close conversation',
      description: 'Closes your conversation. It cannot be reopened by you; start a new conversation to continue later.',
      inputSchema: z.object(authShape).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      run(ctx, async () => {
        const { id, token } = split(args);
        const conv = await authenticateAgent(ctx, id, token);
        return closeConversation(ctx, conv);
      }),
  );

  return server;
}

function jsonRpcError(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

/**
 * Origin must exactly match an allowlisted origin (scheme, host and port).
 * The request's own Host is deliberately not trusted (DNS rebinding).
 * An absent Origin means a non-browser client and is allowed.
 */
export function mcpOriginAllowed(request: Request, allowed: string[]): boolean {
  const origin = request.headers.get('origin');
  if (origin === null) return true;
  return allowed.includes(origin);
}

export function registerMcpRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  app.all('/mcp', async (c: AppContext) => {
    const config = c.get('config');
    const request = c.req.raw;
    if (request.method !== 'POST') {
      return jsonRpcError(405, -32000, 'Method not allowed. This stateless MCP endpoint accepts POST only.', { allow: 'POST' });
    }
    if (!mcpOriginAllowed(request, config.mcpAllowedOrigins)) {
      return jsonRpcError(403, -32000, 'Origin not allowed.');
    }
    const declared = Number(request.headers.get('content-length') ?? '0');
    if (declared > config.limits.mcpBodyMaxBytes) {
      return jsonRpcError(413, -32000, 'Request body too large.');
    }
    const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (mediaType !== 'application/json') {
      return jsonRpcError(415, -32000, 'Content-Type must be application/json.');
    }

    let ctx: ServiceContext;
    try {
      ctx = await buildServiceContext(c, deps, 'mcp');
      await enforceEdgeLimit(ctx, 'mcp');
      await enforceQuota(ctx, `mcp:${ctx.sourceDigest}`, MINUTE, config.limits.mcpPerSourcePerMinute, 'rate_limited_mcp');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'rate_limited') {
        return jsonRpcError(429, -32000, 'Too many requests. Try again later.', {
          'retry-after': String(err.details?.retry_after_seconds ?? 60),
        });
      }
      if (err instanceof ApiError && err.code === 'unavailable') return jsonRpcError(503, -32000, err.message);
      throw err;
    }

    const handler = createMcpHandler(() => buildMcpServer(ctx), {
      maxRequestBodySize: config.limits.mcpBodyMaxBytes,
      onerror: (err) => {
        console.log(JSON.stringify({ level: 'warn', event: 'mcp_transport_error', request_id: ctx.requestId, error: err.name }));
      },
    });
    const response = await handler.fetch(request);
    const headers = new Headers(response.headers);
    headers.set('cache-control', 'no-store');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  });
}
