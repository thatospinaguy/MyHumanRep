/**
 * Worker bindings and configuration. Vars are plain strings so the same type
 * covers local, staging and production. Secrets are optional at the type
 * level and validated at runtime (fail closed when missing).
 */
export interface Env {
  MHR_DB: D1Database;
  ASSETS?: Fetcher;
  RL_PUBLIC?: RateLimit;
  SEND_EMAIL?: SendEmail;

  ENVIRONMENT?: string;
  PUBLIC_BASE_URL?: string;
  ALIAS_HOSTS?: string;
  DEFAULT_RETENTION_DAYS?: string;
  INTAKE_ENABLED?: string;
  ADMIN_AUTH_MODE?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ADMIN_EMAILS?: string;
  MCP_ALLOWED_ORIGINS?: string;
  HSTS_ENABLED?: string;
  NOTIFY_PROVIDER?: string;
  NOTIFY_TO?: string;
  NOTIFY_FROM?: string;
  PUBLIC_CONTACT_EMAIL?: string;

  // Optional numeric overrides for limits (see config.ts for defaults).
  LIMIT_FIRST_CONTACT_PER_SOURCE_PER_HOUR?: string;
  LIMIT_FIRST_CONTACT_GLOBAL_PER_DAY?: string;
  LIMIT_THREAD_OPS_PER_MINUTE?: string;
  LIMIT_MCP_PER_SOURCE_PER_MINUTE?: string;
  LIMIT_AUTH_FAILURES_PER_SOURCE_PER_10_MIN?: string;
  LIMIT_MAX_AGENT_MESSAGES?: string;
  LIMIT_MAX_REQUESTS_TOTAL?: string;
  LIMIT_MAX_REQUESTS_ACTIVE?: string;

  // Secrets
  CONVERSATION_TOKEN_HMAC_KEY?: string;
  CONVERSATION_TOKEN_HMAC_KEY_PREVIOUS?: string;
  RESEND_API_KEY?: string;
}

export type Environment = 'development' | 'staging' | 'production';
