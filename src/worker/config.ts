import type { Env, Environment } from './env';

export interface Limits {
  bodyMaxBytes: number;
  messageMaxChars: number;
  messageMaxBytes: number;
  objectiveMaxChars: number;
  freeTextMaxChars: number;
  shortLabelMaxChars: number;
  maxAgentMessagesPerThread: number;
  maxRequestsTotalPerThread: number;
  maxRequestsActivePerThread: number;
  pageSizeDefault: number;
  pageSizeMax: number;
  minPollIntervalSeconds: number;
  firstContactPerSourcePerHour: number;
  firstContactGlobalPerDay: number;
  threadOpsPerMinute: number;
  mcpPerSourcePerMinute: number;
  authFailuresPerSourcePer10Min: number;
  mcpBodyMaxBytes: number;
}

export interface Config {
  environment: Environment;
  baseUrl: string;
  baseOrigin: string;
  aliasHosts: string[];
  defaultRetentionDays: number;
  intakeEnabledDefault: boolean;
  adminAuthMode: 'access' | 'dev_insecure' | 'invalid';
  accessTeamDomain: string;
  accessAud: string;
  adminEmails: string[];
  mcpAllowedOrigins: string[];
  hstsEnabled: boolean;
  notifyProvider: 'none' | 'log' | 'resend' | 'cloudflare_email';
  notifyTo: string;
  notifyFrom: string;
  publicContactEmail: string | null;
  limits: Limits;
}

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function environmentOf(value: string | undefined): Environment {
  if (value === 'development' || value === 'staging') return value;
  // Anything unknown is treated as production: the strictest posture.
  return 'production';
}

function normalizeBaseUrl(value: string | undefined): string {
  const fallback = 'https://myhumanrep.com';
  if (!value) return fallback;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return fallback;
    return url.origin;
  } catch {
    return fallback;
  }
}

export function loadConfig(env: Env): Config {
  const environment = environmentOf(env.ENVIRONMENT);
  const baseUrl = normalizeBaseUrl(env.PUBLIC_BASE_URL);
  const mode = env.ADMIN_AUTH_MODE ?? 'access';
  let adminAuthMode: Config['adminAuthMode'] = 'invalid';
  if (mode === 'access') adminAuthMode = 'access';
  // The insecure dev mode is only ever honored in the development environment.
  else if (mode === 'dev_insecure' && environment === 'development') adminAuthMode = 'dev_insecure';

  const provider = env.NOTIFY_PROVIDER ?? 'none';
  const notifyProvider: Config['notifyProvider'] =
    provider === 'log' || provider === 'resend' || provider === 'cloudflare_email' ? provider : 'none';

  return {
    environment,
    baseUrl,
    baseOrigin: new URL(baseUrl).origin,
    aliasHosts: list(env.ALIAS_HOSTS).map((h) => h.toLowerCase()),
    defaultRetentionDays: int(env.DEFAULT_RETENTION_DAYS, 30, 1, 365),
    intakeEnabledDefault: env.INTAKE_ENABLED === 'true',
    adminAuthMode,
    accessTeamDomain: (env.ACCESS_TEAM_DOMAIN ?? '').replace(/\/+$/, ''),
    accessAud: env.ACCESS_AUD ?? '',
    adminEmails: list(env.ADMIN_EMAILS).map((e) => e.toLowerCase()),
    mcpAllowedOrigins: [new URL(baseUrl).origin, ...list(env.MCP_ALLOWED_ORIGINS)],
    hstsEnabled: env.HSTS_ENABLED === 'true',
    notifyProvider,
    notifyTo: env.NOTIFY_TO ?? '',
    notifyFrom: env.NOTIFY_FROM ?? '',
    publicContactEmail: /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(env.PUBLIC_CONTACT_EMAIL ?? '') ? env.PUBLIC_CONTACT_EMAIL! : null,
    limits: {
      bodyMaxBytes: 12 * 1024,
      messageMaxChars: 4000,
      messageMaxBytes: 10 * 1024,
      objectiveMaxChars: 3000,
      freeTextMaxChars: 2000,
      shortLabelMaxChars: 150,
      maxAgentMessagesPerThread: int(env.LIMIT_MAX_AGENT_MESSAGES, 50, 1, 1000),
      maxRequestsTotalPerThread: int(env.LIMIT_MAX_REQUESTS_TOTAL, 30, 1, 1000),
      maxRequestsActivePerThread: int(env.LIMIT_MAX_REQUESTS_ACTIVE, 10, 1, 1000),
      pageSizeDefault: 50,
      pageSizeMax: 100,
      minPollIntervalSeconds: 60,
      firstContactPerSourcePerHour: int(env.LIMIT_FIRST_CONTACT_PER_SOURCE_PER_HOUR, 10, 1, 100000),
      firstContactGlobalPerDay: int(env.LIMIT_FIRST_CONTACT_GLOBAL_PER_DAY, 500, 1, 1000000),
      threadOpsPerMinute: int(env.LIMIT_THREAD_OPS_PER_MINUTE, 30, 1, 100000),
      mcpPerSourcePerMinute: int(env.LIMIT_MCP_PER_SOURCE_PER_MINUTE, 60, 1, 100000),
      authFailuresPerSourcePer10Min: int(env.LIMIT_AUTH_FAILURES_PER_SOURCE_PER_10_MIN, 20, 1, 100000),
      mcpBodyMaxBytes: 64 * 1024,
    },
  };
}
