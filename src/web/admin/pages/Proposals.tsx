import { useState, type FormEvent } from 'react';
import { api, qs } from '../api';
import { Badge, ErrorBox, Link, Loading, Notice, SafeText, Time, label, useAction, useLoad } from '../ui';

const STATUSES = ['', 'proposed', 'countered', 'terms_agreed_nonbinding', 'awaiting_authorization', 'cancelled', 'expired'];
const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);
const exponent = (c: string) => (ZERO_DECIMAL.has(c) ? 0 : THREE_DECIMAL.has(c) ? 3 : 2);

export function formatPrice(minor: number | null | undefined, currency: string | null | undefined): string {
  if (minor === null || minor === undefined || !currency) return 'no price';
  return `${(minor / 10 ** exponent(currency)).toFixed(exponent(currency))} ${currency}`;
}

interface QueueItem {
  id: string;
  capability_request_id: string;
  conversation_id: string;
  status: string;
  status_label: string;
  current_revision: number;
  price_minor: number | null;
  currency: string | null;
  scope_excerpt: string;
  sender_label: string | null;
  awaiting_owner: boolean;
  updated_at: string;
}

export function Proposals() {
  const [status, setStatus] = useState('');
  const { data, error, loading } = useLoad(() => api.get<{ items: QueueItem[] }>(`/proposals${qs({ status })}`), [status]);
  return (
    <>
      <h1>Proposals</h1>
      <p className="muted">Nonbinding scope and price negotiations. Nothing here is a contract, a charge or a dispatch, and there is no way to authorize work in this release.</p>
      <form className="filters" onSubmit={(e) => e.preventDefault()}>
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s ? label(s) : 'open'}
              </option>
            ))}
          </select>
        </label>
      </form>
      <Loading loading={loading} />
      <ErrorBox error={error} />
      {data && data.items.length === 0 && <p className="empty">No proposals in this view.</p>}
      {data && data.items.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Updated</th>
                <th>Scope</th>
                <th>Sender label</th>
                <th>Price (nonbinding)</th>
                <th>Revision</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.id} className={p.awaiting_owner ? 'attention' : undefined}>
                  <td>
                    <Time iso={p.updated_at} />
                  </td>
                  <td>
                    <Link to={`/admin/proposals/${p.id}`}>
                      <SafeText text={p.scope_excerpt} />
                    </Link>
                  </td>
                  <td>
                    <SafeText text={p.sender_label} />
                  </td>
                  <td>{formatPrice(p.price_minor, p.currency)}</td>
                  <td>{p.current_revision}</td>
                  <td>
                    <Badge value={p.status} /> {p.awaiting_owner && <span className="badge">awaiting you</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

interface Revision {
  revision: number;
  actor: string;
  scope_text: string;
  deliverables: string[];
  timing_text: string | null;
  location_text: string | null;
  required_skills: string[];
  evidence_requirements: string | null;
  cancellation_terms: string | null;
  price: { amount_minor: number; currency: string } | null;
  valid_until: string;
  changed_fields: string[];
  note: string | null;
  created_at: string;
}

interface ProposalDetail {
  proposal_id: string;
  request_id: string;
  conversation_id: string;
  status: string;
  status_label: string;
  current_revision: number;
  agreed_revision: number | null;
  awaiting: 'agent' | 'human' | null;
  expires_at: string;
  current_terms: Revision | null;
  revisions: Revision[];
  events: Array<{ event_type: string; actor: string; revision: number | null; note: string | null; created_at: string }>;
}

/** Terms form shared by "create" and "counter". Empty fields are left unchanged on a counter. */
function TermsForm({ initialCurrency, submitLabel, requireScope, onSubmit, busy }: {
  initialCurrency: string;
  submitLabel: string;
  requireScope: boolean;
  busy: boolean;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const [scope, setScope] = useState('');
  const [timing, setTiming] = useState('');
  const [location, setLocation] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(initialCurrency);
  const [message, setMessage] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = {};
    if (scope.trim()) body.scope_text = scope.trim();
    if (timing.trim()) body.timing_text = timing.trim();
    if (location.trim()) body.location_text = location.trim();
    if (amount.trim()) body.price = { amount_minor: Math.round(Number(amount) * 10 ** exponent(currency)), currency };
    if (message.trim()) body.message_to_agent = message.trim();
    onSubmit(body);
  };
  return (
    <form onSubmit={submit} className="stack">
      <label htmlFor="t-scope">Scope{requireScope ? '' : ' (leave empty to keep)'}</label>
      <textarea id="t-scope" rows={3} maxLength={4000} value={scope} onChange={(e) => setScope(e.target.value)} />
      <label>
        Timing
        <input value={timing} maxLength={200} onChange={(e) => setTiming(e.target.value)} />
      </label>
      <label>
        Location
        <input value={location} maxLength={150} onChange={(e) => setLocation(e.target.value)} />
      </label>
      <div className="row">
        <label>
          Price (nonbinding)
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 240.00" />
        </label>
        <label>
          Currency
          <input value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
        </label>
      </div>
      <label htmlFor="t-msg">Message to the agent (optional)</label>
      <textarea id="t-msg" rows={2} maxLength={4000} value={message} onChange={(e) => setMessage(e.target.value)} />
      <button type="submit" disabled={busy || (requireScope && scope.trim() === '')}>
        {submitLabel}
      </button>
    </form>
  );
}

export function ProposalDetailPage({ id }: { id: string }) {
  const { data, error, loading, reload } = useLoad(() => api.get<ProposalDetail>(`/proposals/${encodeURIComponent(id)}`), [id]);
  const action = useAction();
  const [note, setNote] = useState('');
  if (loading && !data) return <Loading loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const p = data;
  const open = ['proposed', 'countered', 'terms_agreed_nonbinding', 'awaiting_authorization'].includes(p.status);
  const canAccept = (p.status === 'proposed' || p.status === 'countered') && p.awaiting === 'human';
  const decide = (decision: string, done: string) =>
    void action.run(() => api.post(`/proposals/${id}/decision`, { action: decision, note: note || null }), done).then(reload);
  return (
    <>
      <p>
        <Link to="/admin/proposals">← Proposals</Link> · <Link to={`/admin/requests/${p.request_id}`}>Request</Link> ·{' '}
        <Link to={`/admin/conversations/${p.conversation_id}`}>Conversation</Link>
      </p>
      <h1>Proposal</h1>
      <p className="meta">
        <Badge value={p.status} /> <span className="badge noscope">Nonbinding · no charge · no dispatch</span>{' '}
        <span className="muted">
          revision {p.current_revision}
          {p.agreed_revision ? `, agreed revision ${p.agreed_revision}` : ''} · expires <Time iso={p.expires_at} />
        </span>
      </p>
      <ErrorBox error={action.error} />
      <Notice text={action.notice} />
      <div className="two-col">
        <div>
          <section className="panel">
            <h2>Revisions</h2>
            <table className="compact">
              <thead>
                <tr>
                  <th>#</th>
                  <th>By</th>
                  <th>Scope</th>
                  <th>Timing / location</th>
                  <th>Price</th>
                  <th>Changed</th>
                </tr>
              </thead>
              <tbody>
                {p.revisions.map((r) => (
                  <tr key={r.revision}>
                    <td>{r.revision}</td>
                    <td>{r.actor}</td>
                    <td>
                      <SafeText text={r.scope_text} />
                      {r.note && (
                        <div className="muted small">
                          Note: <SafeText text={r.note} />
                        </div>
                      )}
                    </td>
                    <td>
                      <SafeText text={r.timing_text} /> · <SafeText text={r.location_text} />
                    </td>
                    <td>{formatPrice(r.price?.amount_minor, r.price?.currency)}</td>
                    <td>{r.changed_fields.length ? r.changed_fields.map(label).join(', ') : <span className="muted">initial</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="panel">
            <h2>History</h2>
            <ul className="plain">
              {p.events.map((e, i) => (
                <li key={i}>
                  <Time iso={e.created_at} /> · {label(e.event_type)} by {e.actor}
                  {e.revision ? ` (revision ${e.revision})` : ''}
                  {e.note && (
                    <>
                      {' '}
                      · <SafeText text={e.note} />
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </div>
        <aside>
          {canAccept && (
            <section className="panel">
              <h2>Accept terms (nonbinding)</h2>
              <p className="muted small">Records agreement on revision {p.current_revision}. It is not a contract and authorizes nothing.</p>
              <button
                type="button"
                disabled={action.busy}
                onClick={() => void action.run(() => api.post(`/proposals/${id}/accept`, { revision: p.current_revision }), 'Terms accepted (nonbinding).').then(reload)}
              >
                Accept revision {p.current_revision}
              </button>
            </section>
          )}
          {open && (
            <section className="panel">
              <h2>Counteroffer</h2>
              <TermsForm
                initialCurrency={p.current_terms?.price?.currency ?? 'CAD'}
                submitLabel="Send counteroffer"
                requireScope={false}
                busy={action.busy}
                onSubmit={(body) => void action.run(() => api.post(`/proposals/${id}/counteroffers`, body), 'Counteroffer sent.').then(reload)}
              />
            </section>
          )}
          {open && (
            <section className="panel">
              <h2>Decision</h2>
              <label htmlFor="d-note">Note (agent-visible)</label>
              <textarea id="d-note" rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
              <div className="row">
                {p.status === 'awaiting_authorization' && (
                  <button type="button" disabled={action.busy} onClick={() => decide('return_to_negotiation', 'Returned to negotiation.')}>
                    Return to negotiation
                  </button>
                )}
                <button type="button" disabled={action.busy} onClick={() => decide('decline', 'Declined.')}>
                  Decline
                </button>
              </div>
              <p className="muted small">There is no authorize button: real work needs a verified principal, a contract and payments, which are not built yet.</p>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}

/** Proposal list and "propose scope and price" form, shown on a capability request. */
export function RequestProposals({ requestId }: { requestId: string }) {
  const { data, error, reload } = useLoad(() => api.get<{ items: ProposalDetail[] }>(`/capability-requests/${encodeURIComponent(requestId)}/proposals`), [requestId]);
  const action = useAction();
  return (
    <section className="panel">
      <h2>Proposals (nonbinding)</h2>
      <ErrorBox error={error ?? action.error} />
      <Notice text={action.notice} />
      {data && data.items.length === 0 && <p className="muted">No proposals yet.</p>}
      {data && data.items.length > 0 && (
        <ul className="plain">
          {data.items.map((p) => (
            <li key={p.proposal_id}>
              <Link to={`/admin/proposals/${p.proposal_id}`}>
                {p.status_label}, revision {p.current_revision}
              </Link>{' '}
              · {formatPrice(p.current_terms?.price?.amount_minor, p.current_terms?.price?.currency)}
            </li>
          ))}
        </ul>
      )}
      <details>
        <summary>Propose scope and price</summary>
        <TermsForm
          initialCurrency="CAD"
          submitLabel="Send proposal"
          requireScope
          busy={action.busy}
          onSubmit={(body) => void action.run(() => api.post(`/capability-requests/${requestId}/proposals`, body), 'Proposal sent.').then(reload)}
        />
      </details>
    </section>
  );
}
