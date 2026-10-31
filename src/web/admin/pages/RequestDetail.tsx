import { useEffect, useState, type FormEvent } from 'react';
import { api, type AdminMessage, type AdminRequest } from '../api';
import { RequestProposals } from './Proposals';
import { Badge, ErrorBox, Link, Loading, Notice, SafeText, Time, Unverified, label, useAction, useLoad } from '../ui';

interface Detail {
  request: AdminRequest;
  conversation: {
    id: string;
    subject: string | null;
    sender_label: string | null;
    model_claim: string | null;
    claimed_autonomy: string;
    public_status: string;
    created_via: string;
  };
  linked_messages: AdminMessage[];
  work_scheduled: false;
}

const ACTION_LABELS: Record<string, string> = {
  triaging: 'Mark triaging',
  clarification_requested: 'Ask clarification',
  needs_authorization: 'Needs authorization',
  eligible_for_future_scoping: 'Eligible for future scoping',
  declined: 'Decline',
};

export function RequestDetail({ id }: { id: string }) {
  const { data, error, loading, reload } = useLoad(() => api.get<Detail>(`/capability-requests/${encodeURIComponent(id)}`), [id]);
  const action = useAction();
  const [publicNote, setPublicNote] = useState('');
  const [internalNotes, setInternalNotes] = useState('');
  const [category, setCategory] = useState('');
  const [question, setQuestion] = useState('');
  const [messageToAgent, setMessageToAgent] = useState('');

  useEffect(() => {
    if (data) {
      setPublicNote(data.request.public_status_note ?? '');
      setInternalNotes(data.request.internal_notes ?? '');
      setCategory(data.request.internal_category ?? '');
    }
  }, [data]);

  const patch = (body: Record<string, unknown>, success: string) =>
    action.run(() => api.patch(`/capability-requests/${encodeURIComponent(id)}`, body), success).then((ok) => {
      if (ok) {
        setMessageToAgent('');
        reload();
      }
    });

  const decide = (status: string) => {
    const body: Record<string, unknown> = { status };
    if (publicNote.trim() && publicNote !== (data?.request.public_status_note ?? '')) body['public_status_note'] = publicNote;
    if (messageToAgent.trim()) body['message_to_agent'] = messageToAgent;
    void patch(body, `Status set to ${label(status)}. No work has been scheduled.`);
  };

  const clarify = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await action.run(
      () => api.post(`/capability-requests/${encodeURIComponent(id)}/clarify`, { question }),
      'Clarification question sent to the agent.',
    );
    if (ok) {
      setQuestion('');
      reload();
    }
  };

  if (loading && !data) return <Loading loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const r = data.request;
  const transitions = r.allowed_transitions.filter((t) => t !== 'clarification_requested');

  const field = (name: string, value: string | null) => (
    <>
      <dt>{name}</dt>
      <dd>
        <SafeText text={value} />
      </dd>
    </>
  );

  return (
    <>
      <p>
        <Link to="/admin/requests">← Requests</Link> · <Link to={`/admin/conversations/${r.conversation_id}`}>Open conversation</Link>
      </p>
      <h1>Capability request</h1>
      <p className="meta">
        <Badge value={r.status} /> <span className="badge noscope">No work scheduled</span> <span className="muted">via {r.created_via}</span>
      </p>
      <ErrorBox error={action.error} />
      <Notice text={action.notice} />
      <div className="two-col">
        <div>
          <section className="panel">
            <h2>Objective</h2>
            <pre className="body">
              <SafeText text={r.objective} />
            </pre>
            <dl className="kv">
              {field('Human capability needed', r.human_capability_needed)}
              {field('Context', r.context)}
              {field('Category hint (agent)', r.category_hint)}
              {field('Location (general)', r.location_text)}
              {field('Timing', r.deadline_preference)}
              <dt>Indicative budget</dt>
              <dd>
                {r.budget ? `${r.budget.amount} ${r.budget.currency} (nonbinding)` : <span className="muted">none</span>}
              </dd>
              {field('Deliverables', r.deliverables)}
              {field('Why a human', r.why_human)}
              <dt>Confidentiality preference</dt>
              <dd>{label(r.confidentiality_preference)}</dd>
              <dt>Submitted</dt>
              <dd>
                <Time iso={r.created_at} />
              </dd>
              <dt>Client request id</dt>
              <dd>
                <code>{r.client_request_id}</code>
              </dd>
            </dl>
          </section>
          <section className="panel">
            <h2>Linked messages</h2>
            {data.linked_messages.length === 0 ? (
              <p className="muted">None yet.</p>
            ) : (
              <ol className="thread">
                {data.linked_messages.map((m) => (
                  <li key={m.id} className={`msg ${m.sender}`}>
                    <div className="msg-head">
                      <strong>{m.sender === 'human' ? 'You' : m.sender}</strong> <Time iso={m.created_at} />
                    </div>
                    <pre className="body">
                      <SafeText text={m.body} />
                    </pre>
                  </li>
                ))}
              </ol>
            )}
            <p className="muted small">The agent replies in the conversation thread.</p>
          </section>
        </div>
        <aside>
          <section className="panel">
            <h2>Sender (self-reported)</h2>
            <p>
              <SafeText text={data.conversation.sender_label} /> · {label(data.conversation.claimed_autonomy)} <Unverified />
            </p>
          </section>
          <section className="panel">
            <h2>Decision</h2>
            <div className="stack">
              <label htmlFor="pnote">
                Public status note <span className="muted">(agent-visible)</span>
              </label>
              <textarea id="pnote" rows={3} maxLength={2000} value={publicNote} onChange={(e) => setPublicNote(e.target.value)} />
              <label htmlFor="mta">
                Optional message to agent <span className="muted">(posted to the thread with the decision)</span>
              </label>
              <textarea id="mta" rows={3} maxLength={4000} value={messageToAgent} onChange={(e) => setMessageToAgent(e.target.value)} />
              <div className="actions">
                {transitions.length === 0 && <p className="muted">No transitions available.</p>}
                {transitions.map((t) => (
                  <button key={t} type="button" className={t === 'declined' ? 'danger' : undefined} disabled={action.busy} onClick={() => decide(t)}>
                    {ACTION_LABELS[t] ?? label(t)}
                  </button>
                ))}
              </div>
              {publicNote !== (r.public_status_note ?? '') && (
                <button type="button" onClick={() => void patch({ public_status_note: publicNote }, 'Public note saved.')}>
                  Save public note only
                </button>
              )}
            </div>
          </section>
          {r.allowed_transitions.includes('clarification_requested') && (
            <section className="panel">
              <h2>Ask for clarification</h2>
              <form onSubmit={clarify} className="stack">
                <label htmlFor="q">Question (agent-visible message)</label>
                <textarea id="q" rows={3} maxLength={4000} value={question} onChange={(e) => setQuestion(e.target.value)} />
                <button type="submit" disabled={action.busy || question.trim() === ''}>
                  Send question
                </button>
              </form>
            </section>
          )}
          <RequestProposals requestId={id} />
          <section className="panel">
            <h2>Private</h2>
            <div className="stack">
              <label>
                Research category (internal)
                <input value={category} onChange={(e) => setCategory(e.target.value)} maxLength={64} />
              </label>
              <label htmlFor="inotes">Internal notes</label>
              <textarea id="inotes" rows={4} maxLength={5000} value={internalNotes} onChange={(e) => setInternalNotes(e.target.value)} />
              <button type="button" onClick={() => void patch({ internal_notes: internalNotes, internal_category: category }, 'Private notes saved.')}>
                Save private fields
              </button>
            </div>
          </section>
        </aside>
      </div>
    </>
  );
}
