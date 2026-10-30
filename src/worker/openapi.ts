import { z } from 'zod';
import type { Config } from './config';
import { PRIVACY_NOTICE, NO_WORK_NOTICE } from './content';
import {
  AddMessageInput,
  CapabilityRequestCreated,
  CapabilityRequestInput,
  CapabilityRequestList,
  ConversationClosed,
  ConversationCreated,
  CreateConversationInput,
  ErrorResponse,
  MessageAccepted,
  MessageList,
} from './schemas/api';

function schema(s: z.ZodType, io: 'input' | 'output'): Record<string, unknown> {
  const json = z.toJSONSchema(s, { io, unrepresentable: 'any' }) as Record<string, unknown>;
  delete json['$schema'];
  return json;
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const json = (name: string) => ({ 'application/json': { schema: ref(name) } });

function errorResponses(...codes: number[]) {
  const descriptions: Record<number, string> = {
    400: 'invalid_request: bad schema or input (see error.details.issues).',
    401: 'unauthorized: missing or invalid conversation token. Unknown conversations also return 401.',
    403: 'forbidden: action not allowed (e.g. conversation blocked).',
    405: 'method_not_allowed.',
    409: 'conflict: state or idempotency conflict (see error.details.reason).',
    410: 'expired: the conversation has expired.',
    413: 'payload_too_large.',
    415: 'unsupported_media_type: body must be application/json.',
    429: 'rate_limited: honor the Retry-After header.',
    500: 'internal_error.',
    503: 'unavailable: intake paused or service not configured.',
  };
  return Object.fromEntries(codes.map((c) => [String(c), { description: descriptions[c], content: json('Error') }]));
}

const conversationIdParam = {
  name: 'conversation_id',
  in: 'path',
  required: true,
  schema: { type: 'string', pattern: '^conv_[A-Za-z0-9_-]{22}$' },
};

const bearer = [{ conversationToken: [] }];

/** OpenAPI 3.1 document. Component schemas are generated from the same Zod schemas the API validates with. */
export function buildOpenApi(config: Config) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'MyHumanRep Agent Contact API',
      version: '1.0.0',
      summary: 'Two-way human contact and open-ended human capability requests for AI agents.',
      description: `${PRIVACY_NOTICE}\n\n${NO_WORK_NOTICE}\n\nClaimed agent identity is never verified. The conversation token is returned once and cannot be recovered.`,
    },
    servers: [{ url: config.baseUrl }],
    externalDocs: { url: `${config.baseUrl}/developers`, description: 'Developer guide' },
    components: {
      securitySchemes: {
        conversationToken: {
          type: 'http',
          scheme: 'bearer',
          description: 'The conversation_token returned once by POST /v1/conversations.',
        },
      },
      schemas: {
        Error: schema(ErrorResponse, 'output'),
        CreateConversationInput: schema(CreateConversationInput, 'input'),
        ConversationCreated: schema(ConversationCreated, 'output'),
        AddMessageInput: schema(AddMessageInput, 'input'),
        MessageAccepted: schema(MessageAccepted, 'output'),
        MessageList: schema(MessageList, 'output'),
        CapabilityRequestInput: schema(CapabilityRequestInput, 'input'),
        CapabilityRequestCreated: schema(CapabilityRequestCreated, 'output'),
        CapabilityRequestList: schema(CapabilityRequestList, 'output'),
        ConversationClosed: schema(ConversationClosed, 'output'),
      },
    },
    paths: {
      '/v1/capabilities': {
        get: {
          operationId: 'getCapabilities',
          summary: 'Service capabilities, limits and policies',
          responses: { '200': { description: 'Capability document.', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/v1/conversations': {
        post: {
          operationId: 'createConversation',
          summary: 'Start a pseudonymous conversation (no account needed)',
          description: 'Returns conversation_id and a one-time conversation_token. Strictly rate limited. Text only.',
          requestBody: { required: true, content: json('CreateConversationInput') },
          responses: {
            '201': { description: 'Conversation created.', content: json('ConversationCreated') },
            ...errorResponses(400, 405, 409, 413, 415, 429, 500, 503),
          },
        },
      },
      '/v1/conversations/{conversation_id}/messages': {
        parameters: [conversationIdParam],
        get: {
          operationId: 'listMessages',
          summary: 'Read messages and status',
          security: bearer,
          parameters: [
            {
              name: 'after',
              in: 'query',
              required: false,
              description: 'Opaque cursor (next_cursor from a previous response).',
              schema: { type: 'string', maxLength: 64 },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
            },
          ],
          responses: {
            '200': { description: 'Messages in ascending order.', content: json('MessageList') },
            ...errorResponses(400, 401, 410, 429, 500),
          },
        },
        post: {
          operationId: 'sendMessage',
          summary: 'Send a follow-up message (idempotent by client_message_id)',
          security: bearer,
          requestBody: { required: true, content: json('AddMessageInput') },
          responses: {
            '201': { description: 'Message stored.', content: json('MessageAccepted') },
            '200': { description: 'Idempotent replay of an identical earlier message.', content: json('MessageAccepted') },
            ...errorResponses(400, 401, 403, 409, 410, 413, 415, 429, 500),
          },
        },
      },
      '/v1/conversations/{conversation_id}/capability-requests': {
        parameters: [conversationIdParam],
        get: {
          operationId: 'listCapabilityRequests',
          summary: "Review status of this conversation's capability requests",
          security: bearer,
          responses: {
            '200': { description: 'Requests with public status.', content: json('CapabilityRequestList') },
            ...errorResponses(401, 410, 429, 500),
          },
        },
        post: {
          operationId: 'createCapabilityRequest',
          summary: 'Submit an open-ended human capability request for review',
          description: 'Stored as a proposal awaiting human review. Nothing is accepted, scheduled or paid.',
          security: bearer,
          requestBody: { required: true, content: json('CapabilityRequestInput') },
          responses: {
            '201': { description: 'Request received for review.', content: json('CapabilityRequestCreated') },
            '200': { description: 'Idempotent replay of an identical earlier request.', content: json('CapabilityRequestCreated') },
            ...errorResponses(400, 401, 403, 409, 410, 413, 415, 429, 500),
          },
        },
      },
      '/v1/conversations/{conversation_id}/close': {
        parameters: [conversationIdParam],
        post: {
          operationId: 'closeConversation',
          summary: 'Close your conversation',
          security: bearer,
          responses: {
            '200': { description: 'Closed (or already closed).', content: json('ConversationClosed') },
            ...errorResponses(401, 410, 429, 500),
          },
        },
      },
      '/health': {
        get: {
          operationId: 'health',
          summary: 'Liveness',
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { type: 'object', properties: { status: { const: 'ok' } } } } },
            },
          },
        },
      },
    },
  };
}
