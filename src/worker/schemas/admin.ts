import { z } from 'zod';
import { freeText, shortLabel, text } from './fields';
import { ACCEPTED_AUTONOMY_VALUES, CONVERSATION_STATUSES, INTENTS_EXTENDED, REQUEST_STATUSES } from './api';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z?)?$/, 'Use an ISO-8601 date or UTC timestamp.');

export const CONVERSATION_FILTER_STATUSES = [...CONVERSATION_STATUSES, 'blocked', 'expired', 'active'] as const;

export const ConversationListQuery = z
  .object({
    status: z.enum(CONVERSATION_FILTER_STATUSES).optional(),
    intent: z.enum(INTENTS_EXTENDED).optional(),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
    claimed_autonomy: z.enum(ACCEPTED_AUTONOMY_VALUES).optional(),
    has_requests: z.enum(['true', 'false']).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

/** Search runs via POST so free-text queries never land in URLs or access logs. */
export const ConversationSearchInput = ConversationListQuery.omit({ limit: true })
  .extend({
    q: z.string().trim().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();

export const AdminReplyInput = z
  .object({
    message: text({ maxChars: 4000, maxBytes: 10 * 1024, multiline: true, description: 'Reply visible to the agent.' }),
  })
  .strict();

export const CONVERSATION_ACTIONS = ['close', 'reopen', 'block', 'unblock', 'revoke_credential'] as const;

export const ConversationPatchInput = z
  .object({
    action: z.enum(CONVERSATION_ACTIONS).optional(),
    internal_priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
    internal_tags: z
      .array(z.string().trim().min(1).max(40).regex(/^[\p{L}\p{N} _:.-]+$/u, 'Tags use letters, numbers, space, _ : . -'))
      .max(20)
      .optional(),
    internal_notes: z.union([freeText('Private owner note.', 5000), z.literal(''), z.null()]).optional(),
    intent: z.enum(INTENTS_EXTENDED).optional(),
    under_review: z.boolean().optional(),
    retention_hold: z.boolean().optional(),
    extend_days: z.number().int().min(1).max(365).optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Provide at least one field to change.' });

export const RequestListQuery = z
  .object({
    status: z.enum([...REQUEST_STATUSES, 'open']).optional(),
    category: z.string().max(64).optional(),
    via: z.enum(['rest', 'mcp']).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const RequestPatchInput = z
  .object({
    status: z.enum(REQUEST_STATUSES).optional(),
    public_status_note: z.union([freeText('Agent-visible status note.', 2000), z.literal(''), z.null()]).optional(),
    internal_notes: z.union([freeText('Private owner note.', 5000), z.literal(''), z.null()]).optional(),
    internal_category: z.union([shortLabel('Owner research taxonomy label.', 64), z.literal(''), z.null()]).optional(),
    capability_slugs: z.array(z.string().max(64)).max(10).optional().describe('Owner-confirmed registry classification.'),
    message_to_agent: text({
      maxChars: 4000,
      maxBytes: 10 * 1024,
      multiline: true,
      description: 'Optional agent-visible message posted to the linked conversation in the same transaction.',
    }).optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Provide at least one field to change.' });

export const ClarifyInput = z
  .object({
    question: text({ maxChars: 4000, maxBytes: 10 * 1024, multiline: true, description: 'Clarification question for the agent.' }),
  })
  .strict();

export const DeleteConversationInput = z
  .object({
    confirm: z.string().max(64).describe('Must equal the conversation id.'),
  })
  .strict();

export const AuditListQuery = z
  .object({
    action: z.string().max(64).optional(),
    target_type: z.string().max(32).optional(),
    target_id: z.string().max(64).optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
    format: z.enum(['json', 'csv']).default('json'),
  })
  .strict();

export const MetricsQuery = z
  .object({
    format: z.enum(['json', 'csv']).default('json'),
  })
  .strict();
