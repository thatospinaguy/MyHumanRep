export type ErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'method_not_allowed'
  | 'conflict'
  | 'expired'
  | 'unprocessable_request'
  | 'not_yet_available'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'rate_limited'
  | 'internal_error'
  | 'unavailable';

export const STATUS_BY_CODE: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  expired: 410,
  unprocessable_request: 422,
  not_yet_available: 501,
  payload_too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  internal_error: 500,
  unavailable: 503,
};

/**
 * Machine-readable detail. `reason` is a stable snake_case sub-code agents can
 * branch on; `issues` lists validation problems by field path.
 */
export interface ErrorDetails {
  reason?: string;
  issues?: Array<{ path: string; message: string }>;
  retry_after_seconds?: number;
  [key: string]: unknown;
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ErrorDetails | undefined;

  constructor(code: ErrorCode, message: string, details?: ErrorDetails) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    request_id: string;
    details?: ErrorDetails;
  };
}

export function errorBody(err: ApiError, requestId: string): ErrorBody {
  return {
    error: {
      code: err.code,
      message: err.message,
      request_id: requestId,
      ...(err.details ? { details: err.details } : {}),
    },
  };
}

export const errors = {
  invalid: (message: string, details?: ErrorDetails) => new ApiError('invalid_request', message, details),
  unauthorized: () =>
    new ApiError('unauthorized', 'Missing or invalid conversation credential.', {
      reason: 'invalid_credential',
      hint: 'Send the conversation_token returned when the conversation was created as "Authorization: Bearer <token>". Tokens cannot be recovered or reissued.',
    }),
  unauthorizedAccount: () =>
    new ApiError('unauthorized', 'Missing or invalid agent account credential.', {
      reason: 'invalid_account_credential',
      hint: 'Send the account_token from POST /v1/agent-accounts as "Authorization: Bearer <token>". Conversation tokens are not account tokens.',
    }),
  notFound: (message = 'Not found.') => new ApiError('not_found', message),
  conflict: (message: string, reason: string) => new ApiError('conflict', message, { reason }),
  forbidden: (message: string, reason: string) => new ApiError('forbidden', message, { reason }),
  expired: () =>
    new ApiError('expired', 'This conversation has expired.', {
      reason: 'conversation_expired',
      hint: 'Start a new conversation with POST /v1/conversations if you still need help.',
    }),
  rateLimited: (retryAfterSeconds: number) =>
    new ApiError('rate_limited', 'Too many requests. Try again later.', {
      reason: 'rate_limited',
      retry_after_seconds: retryAfterSeconds,
    }),
  unavailable: (message: string, reason: string) => new ApiError('unavailable', message, { reason }),
  unprocessable: (message: string, reason: string) => new ApiError('unprocessable_request', message, { reason }),
  notYetAvailable: (feature: string, hint?: string) =>
    new ApiError('not_yet_available', `${feature} is not operational yet. Nothing was created or charged.`, {
      reason: 'not_yet_available',
      feature,
      ...(hint ? { hint } : {}),
    }),
};
