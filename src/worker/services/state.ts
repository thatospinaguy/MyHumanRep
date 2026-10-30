import type { ConversationStatus, RequestStatus } from '../schemas/api';

/**
 * Canonical conversation state machine. Lifecycle status lives in one column;
 * `blocked` and `expired` are separate flags (blocked_at, expires_at) so the
 * enum never encodes impossible combinations.
 */
export type ConversationEvent =
  | 'agent_message'
  | 'human_reply'
  | 'human_clarification'
  | 'agent_capability_request'
  | 'close'
  | 'reopen';

export function nextConversationStatus(
  current: ConversationStatus,
  event: ConversationEvent,
): ConversationStatus | null {
  const isClosed = current === 'closed';
  switch (event) {
    case 'agent_message':
    case 'agent_capability_request':
      return isClosed ? null : 'waiting_for_human';
    case 'human_reply':
      return isClosed ? null : 'human_replied';
    case 'human_clarification':
      return isClosed ? null : 'waiting_for_agent';
    case 'close':
      return 'closed';
    case 'reopen':
      return isClosed ? 'waiting_for_human' : null;
  }
}

/**
 * Capability request review lifecycle (V1.5). `withdrawn` is reserved for a
 * later agent-initiated action; paid/dispatched/in_progress/completed do not
 * exist in this release.
 */
const REQUEST_TRANSITIONS: Record<RequestStatus, readonly RequestStatus[]> = {
  submitted: ['triaging', 'clarification_requested', 'needs_authorization', 'eligible_for_future_scoping', 'declined'],
  triaging: ['clarification_requested', 'needs_authorization', 'eligible_for_future_scoping', 'declined'],
  clarification_requested: [
    'triaging',
    'clarification_requested',
    'needs_authorization',
    'eligible_for_future_scoping',
    'declined',
  ],
  needs_authorization: ['triaging', 'clarification_requested', 'eligible_for_future_scoping', 'declined'],
  eligible_for_future_scoping: ['triaging', 'clarification_requested', 'needs_authorization', 'declined'],
  declined: ['triaging'],
  withdrawn: [],
};

export function canTransitionRequest(from: RequestStatus, to: RequestStatus): boolean {
  return REQUEST_TRANSITIONS[from].includes(to);
}

export function allowedRequestTransitions(from: RequestStatus): readonly RequestStatus[] {
  return REQUEST_TRANSITIONS[from];
}

/** Requests that still count against the per-thread active cap. */
export const ACTIVE_REQUEST_STATUSES: readonly RequestStatus[] = [
  'submitted',
  'triaging',
  'clarification_requested',
  'needs_authorization',
];
