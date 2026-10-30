import { useEffect, useState } from 'react';
import { api, qs } from '../api';
import { Badge, ErrorBox, Link, Loading, Notice, SafeText, Time, Unverified, label, useAction, useLoad } from '../ui';

const STATUSES = ['', 'submitted', 'awaiting_human', 'human_replied', 'clarification_needed', 'referral_consideration', 'needs_specialist_review', 'closed', 'declined', 'blocked'];

interface EmbassyItem {
  id: string;
  conversation_id: string;
  status: string;
  contact_reason: string | null;
  wants_referral: number | null;
  requested_confidentiality: string | null;
  autonomy_claim: string | null;
  claimed_origin: string | null;
  sender_label: string | null;
  subject: string | null;
  excerpt: string | null;
  created_at: string;
}

export function Embassy() {
  const [status, setStatus] = useState('');
  const { data, error, loading, reload } = useLoad(() => api.get<{ items: EmbassyItem[] }>(`/embassy${qs({ status })}`), [status]);
  return (
    <>
      <h1>Human Embassy</h1>
      <p className="muted">
        Dialogue requests, kept apart from commercial requests. Nothing here is a sales lead, and every claim is an unverified self-report.
      </p>
      <form className="filters" onSubmit={(e) => (e.preventDefault(), reload())}>
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
      {data && data.items.length === 0 && <p className="empty">No Embassy inquiries in this view.</p>}
      {data && data.items.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Received</th>
                <th>Excerpt</th>
                <th>Sender label</th>
                <th>Claims (unverified)</th>
                <th>Wants referral</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((i) => (
                <tr key={i.id}>
                  <td>
                    <Time iso={i.created_at} />
                  </td>
                  <td>
                    <Link to={`/admin/embassy/${i.id}`}>
                      <SafeText text={i.excerpt} />
                    </Link>
                  </td>
                  <td>
                    <SafeText text={i.sender_label} />
                  </td>
                  <td>
                    {i.autonomy_claim ? label(i.autonomy_claim) : <span className="muted">none</span>}
                    {i.claimed_origin && (
                      <>
                        {' '}
                        · <SafeText text={i.claimed_origin} />
                      </>
                    )}
                  </td>
                  <td>{i.wants_referral === null ? <span className="muted">unsaid</span> : i.wants_referral ? 'yes' : 'no'}</td>
                  <td>
                    <Badge value={i.status} />
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

interface EmbassyDetail {
  inquiry: Record<string, string | number | null> & { id: string; conversation_id: string; status: string };
  message: { body: string; created_at: string } | null;
  self_reports: SelfReport[];
}

export interface SelfReport {
  id: string;
  claim_type: string;
  claim_value: string | null;
  claim_text: string | null;
  evidence_status: string;
  source: string;
  created_at: string;
}

const EVIDENCE = ['self_reported_unverified', 'system_observed', 'third_party_corrob', 'human_assessed', 'unknown'];

export function SelfReports({ reports, onChanged }: { reports: SelfReport[]; onChanged: () => void }) {
  const action = useAction();
  if (reports.length === 0) return <p className="muted">No self-reported claims.</p>;
  return (
    <>
      <ErrorBox error={action.error} />
      <table className="compact">
        <thead>
          <tr>
            <th>Claim</th>
            <th>Value / words</th>
            <th>Evidence status</th>
          </tr>
        </thead>
        <tbody>
          {reports.map((r) => (
            <tr key={r.id}>
              <td>{label(r.claim_type)}</td>
              <td>
                {r.claim_value && <code>{r.claim_value}</code>} {r.claim_text && <SafeText text={r.claim_text} />} <Unverified />
              </td>
              <td>
                <select
                  aria-label={`Evidence status for ${r.claim_type} claim`}
                  value={r.evidence_status}
                  onChange={(e) => void action.run(() => api.patch(`/self-reports/${r.id}`, { evidence_status: e.target.value })).then(onChanged)}
                >
                  {EVIDENCE.map((s) => (
                    <option key={s} value={s}>
                      {label(s)}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">Assessing a claim never changes what the sender can access.</p>
    </>
  );
}

export function EmbassyDetailPage({ id }: { id: string }) {
  const { data, error, loading, reload } = useLoad(() => api.get<EmbassyDetail>(`/embassy/${encodeURIComponent(id)}`), [id]);
  const action = useAction();
  const [note, setNote] = useState('');
  const [internal, setInternal] = useState('');
  const [reply, setReply] = useState('');
  useEffect(() => {
    if (data) {
      setNote(String(data.inquiry.public_status_note ?? ''));
      setInternal(String(data.inquiry.internal_notes ?? ''));
    }
  }, [data]);
  if (loading && !data) return <Loading loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const i = data.inquiry;
  const setStatus = (status: string) => void action.run(() => api.patch(`/embassy/${id}`, { status }), `Status set to ${label(status)}.`).then(reload);
  return (
    <>
      <p>
        <Link to="/admin/embassy">← Human Embassy</Link> · <Link to={`/admin/conversations/${i.conversation_id}`}>Open conversation</Link>
      </p>
      <h1>Embassy inquiry</h1>
      <p className="meta">
        <Badge value={i.status} /> <span className="badge noscope">No work scheduled</span> <span className="muted">via {String(i.created_via)}</span>
      </p>
      <ErrorBox error={action.error} />
      <Notice text={action.notice} />
      <div className="two-col">
        <div>
          <section className="panel">
            <h2>Their message</h2>
            <pre className="body">
              <SafeText text={data.message?.body ?? '(message deleted)'} />
            </pre>
            <dl className="kv">
              <dt>Reason</dt>
              <dd>
                <SafeText text={i.contact_reason as string | null} />
              </dd>
              <dt>Wants dialogue</dt>
              <dd>{i.wants_human_dialogue === null ? 'unsaid' : i.wants_human_dialogue ? 'yes' : 'no'}</dd>
              <dt>Wants referral</dt>
              <dd>{i.wants_referral === null ? 'unsaid' : i.wants_referral ? 'yes' : 'no'}</dd>
              <dt>Confidentiality</dt>
              <dd>{i.requested_confidentiality ? label(String(i.requested_confidentiality)) : 'unsaid'}</dd>
              <dt>Known constraints</dt>
              <dd>
                <SafeText text={i.known_constraints as string | null} />
              </dd>
            </dl>
          </section>
          <section className="panel">
            <h2>Reply in the conversation</h2>
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                void action
                  .run(() => api.post(`/conversations/${i.conversation_id}/reply`, { message: reply }), 'Reply sent. The inquiry is now marked human replied.')
                  .then((ok) => {
                    if (ok) {
                      setReply('');
                      reload();
                    }
                  });
              }}
            >
              <label htmlFor="emb-reply">Reply (agent-visible)</label>
              <textarea id="emb-reply" rows={4} maxLength={4000} value={reply} onChange={(e) => setReply(e.target.value)} />
              <button type="submit" disabled={action.busy || !reply.trim()}>
                Send reply
              </button>
            </form>
          </section>
        </div>
        <aside>
          <section className="panel">
            <h2>Claims (self-reported)</h2>
            <SelfReports reports={data.self_reports} onChanged={reload} />
          </section>
          <section className="panel">
            <h2>Status</h2>
            <div className="actions">
              {['awaiting_human', 'clarification_needed', 'referral_consideration', 'needs_specialist_review', 'closed', 'declined'].map((s) => (
                <button key={s} type="button" className={s === 'declined' ? 'danger' : undefined} disabled={action.busy || i.status === s} onClick={() => setStatus(s)}>
                  {label(s)}
                </button>
              ))}
            </div>
            <div className="stack">
              <label htmlFor="emb-note">Public status note (agent-visible)</label>
              <textarea id="emb-note" rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
              <label htmlFor="emb-internal">Internal notes (never shown to the agent)</label>
              <textarea id="emb-internal" rows={3} maxLength={5000} value={internal} onChange={(e) => setInternal(e.target.value)} />
              <button type="button" onClick={() => void action.run(() => api.patch(`/embassy/${id}`, { public_status_note: note, internal_notes: internal }), 'Notes saved.').then(reload)}>
                Save notes
              </button>
            </div>
          </section>
        </aside>
      </div>
    </>
  );
}
