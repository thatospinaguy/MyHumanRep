import type { ConversationStatus, PublicConversationStatus, RequestStatus } from '../schemas/api';

export interface ConversationRow {
  id: string;
  token_digest: string;
  status: ConversationStatus;
  intent: string;
  sender_label: string | null;
  model_claim: string | null;
  claimed_autonomy: string;
  language: string | null;
  subject: string | null;
  internal_priority: string;
  internal_tags_json: string;
  internal_notes: string | null;
  under_review: number;
  retention_hold: number;
  created_via: 'rest' | 'mcp';
  agent_message_count: number;
  human_message_count: number;
  created_at: string;
  updated_at: string;
  expires_at: string;
  closed_at: string | null;
  closed_by: string | null;
  blocked_at: string | null;
  last_agent_message_at: string | null;
  last_human_message_at: string | null;
  last_agent_read_at: string | null;
  autonomy_claim: string | null;
  intent_label: string | null;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  seq: number;
  sender: 'agent' | 'human' | 'system_notice';
  body: string;
  client_message_id: string | null;
  body_hash: string | null;
  via: string;
  created_at: string;
  delivered_at: string | null;
  capability_request_id: string | null;
}

export interface CapabilityRequestRow {
  id: string;
  conversation_id: string;
  client_request_id: string;
  payload_hash: string;
  objective: string;
  human_capability_needed: string | null;
  context: string | null;
  category_hint: string | null;
  location_text: string | null;
  deadline_preference: string | null;
  budget_amount_minor: number | null;
  budget_currency: string | null;
  deliverables: string | null;
  why_human: string | null;
  confidentiality_preference: 'standard' | 'request_discussion';
  status: RequestStatus;
  public_status_note: string | null;
  internal_notes: string | null;
  internal_category: string | null;
  created_via: 'rest' | 'mcp';
  created_at: string;
  updated_at: string;
}

export function isExpired(conv: Pick<ConversationRow, 'expires_at'>, now: Date): boolean {
  return conv.expires_at <= now.toISOString();
}

export function publicStatus(conv: ConversationRow, now: Date): PublicConversationStatus {
  if (isExpired(conv, now)) return 'expired';
  if (conv.blocked_at) return 'blocked';
  return conv.status;
}

export function parseTags(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}
