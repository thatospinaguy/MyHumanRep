export class ApiFailure extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (res.status === 401 || res.status === 403) {
    // Access session expired or revoked: reload so Cloudflare Access can re-authenticate.
    if (res.headers.get('content-type')?.includes('application/json')) {
      const body = (await res.json()) as { error?: { code: string; message: string; details?: Record<string, unknown> } };
      throw new ApiFailure(res.status, body.error?.code ?? 'unauthorized', body.error?.message ?? 'Not authorized.', body.error?.details);
    }
    throw new ApiFailure(res.status, 'unauthorized', 'Your admin session is not valid. Reload to sign in again.');
  }
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok) {
    if (type.includes('application/json')) {
      const body = (await res.json()) as { error?: { code: string; message: string; details?: Record<string, unknown> } };
      const issues = (body.error?.details?.['issues'] as Array<{ path: string; message: string }> | undefined)
        ?.map((i) => `${i.path}: ${i.message}`)
        .join('; ');
      throw new ApiFailure(res.status, body.error?.code ?? 'error', [body.error?.message, issues].filter(Boolean).join(' '), body.error?.details);
    }
    throw new ApiFailure(res.status, 'error', `Request failed (${res.status}).`);
  }
  return (await res.json()) as T;
}

const WRITE_HEADERS = { 'content-type': 'application/json', 'x-mhr-admin': '1' };

/** An expired Access session redirects cross-origin, which fetch reports as a network error. */
function fetchAdmin(input: string, init?: RequestInit): Promise<Response> {
  return fetch(input, { credentials: 'same-origin', redirect: 'manual', ...init }).then(
    (res) => {
      if (res.type === 'opaqueredirect') {
        throw new ApiFailure(401, 'session_expired', 'Your admin session expired. Reload the page to sign in again.');
      }
      return res;
    },
    () => {
      throw new ApiFailure(0, 'network', 'Network error, or your admin session expired. Reload the page to sign in again.');
    },
  );
}

export const api = {
  get: <T>(path: string) => fetchAdmin(`/admin/api${path}`).then((r) => handle<T>(r)),
  post: <T>(path: string, body?: unknown) =>
    fetchAdmin(`/admin/api${path}`, { method: 'POST', headers: WRITE_HEADERS, body: JSON.stringify(body ?? {}) }).then((r) =>
      handle<T>(r),
    ),
  patch: <T>(path: string, body: unknown) =>
    fetchAdmin(`/admin/api${path}`, { method: 'PATCH', headers: WRITE_HEADERS, body: JSON.stringify(body) }).then((r) =>
      handle<T>(r),
    ),
  del: <T>(path: string, body: unknown) =>
    fetchAdmin(`/admin/api${path}`, { method: 'DELETE', headers: WRITE_HEADERS, body: JSON.stringify(body) }).then((r) =>
      handle<T>(r),
    ),
  /** POST that returns a file; saved via an object URL, never a URL containing data. */
  download: async (path: string, filename: string) => {
    const res = await fetchAdmin(`/admin/api${path}`, { method: 'POST', headers: WRITE_HEADERS, body: '{}' });
    if (!res.ok) await handle(res);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};

export function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

// ---------- Types (subset of the admin API responses) ----------

export interface Session {
  email: string;
  auth_mode: string;
  environment: string;
  intake_enabled: boolean;
  notify_provider: string;
}

export interface ConversationSummary {
  id: string;
  subject: string | null;
  sender_label: string | null;
  model_claim: string | null;
  claimed_autonomy: string;
  autonomy_claim: string | null;
  claims_verified: false;
  intent: string;
  status: string;
  public_status: string;
  blocked: boolean;
  expired: boolean;
  under_review: boolean;
  retention_hold: boolean;
  internal_priority: string;
  internal_tags: string[];
  created_via: string;
  message_count: number;
  request_count: number;
  open_request_count: number;
  awaiting_owner: boolean;
  created_at: string;
  updated_at: string;
  expires_at: string;
  closed_at: string | null;
  last_agent_read_at: string | null;
}

export interface AdminMessage {
  id: string;
  seq: number;
  sender: 'agent' | 'human' | 'system_notice';
  body: string;
  via: string;
  capability_request_id: string | null;
  created_at: string;
  delivered_at: string | null;
}

export interface AdminRequest {
  id: string;
  conversation_id: string;
  client_request_id: string;
  objective: string;
  human_capability_needed: string | null;
  context: string | null;
  category_hint: string | null;
  location_text: string | null;
  deadline_preference: string | null;
  budget: { amount: number; amount_minor: number; currency: string } | null;
  deliverables: string | null;
  why_human: string | null;
  confidentiality_preference: string;
  status: string;
  public_status_note: string | null;
  internal_notes: string | null;
  internal_category: string | null;
  created_via: string;
  created_at: string;
  updated_at: string;
  allowed_transitions: string[];
  conversation?: { id: string; subject: string | null; sender_label: string | null; claimed_autonomy: string };
}

export interface ConversationDetail {
  conversation: ConversationSummary & {
    language: string | null;
    internal_notes: string | null;
    closed_by: string | null;
    credential_revoked: boolean;
  };
  messages: AdminMessage[];
  requests: AdminRequest[];
  notifications: Array<{ event_type: string; status: string; attempts: number; last_error_code: string | null; created_at: string }>;
  self_reports: Array<{ id: string; claim_type: string; claim_value: string | null; claim_text: string | null; evidence_status: string; source: string; created_at: string }>;
  embassy_inquiries: Array<{ id: string; status: string; created_at: string }>;
  work_scheduled: false;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}
