import { useEffect, useState, type FormEvent } from 'react';
import { api, type ConversationDetail } from '../api';
import { SelfReports } from './Embassy';
import { Badge, ErrorBox, Link, Loading, Notice, SafeText, Time, Unverified, label, navigate, useAction, useLoad } from '../ui';

const INTENTS = ['general_inquiry', 'capability_request', 'research_question', 'other'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

export function Conversation({ id }: { id: string }) {
  const { data, error, loading, reload } = useLoad(() => api.get<ConversationDetail>(`/conversations/${encodeURIComponent(id)}`), [id]);
  const action = useAction();
  const [reply, setReply] = useState('');
  const [notes, setNotes] = useState('');
  const [tags, setTags] = useState('');

  useEffect(() => {
    if (data) {
      setNotes(data.conversation.internal_notes ?? '');
      setTags(data.conversation.internal_tags.join(', '));
    }
  }, [data]);

  const patch = (body: Record<string, unknown>, success: string) =>
    action.run(() => api.patch(`/conversations/${encodeURIComponent(id)}`, body), success).then((ok) => ok && reload());

  const sendReply = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await action.run(() => api.post(`/conversations/${encodeURIComponent(id)}/reply`, { message: reply }), 'Reply sent. The agent will see it next time it polls.');
    if (ok) {
      setReply('');
      reload();
    }
  };

  const remove = async () => {
    const typed = window.prompt(`This permanently deletes the conversation, its messages and requests.\nType the conversation id to confirm:\n${id}`);
    if (typed === null) return;
    const ok = await action.run(() => api.del(`/conversations/${encodeURIComponent(id)}`, { confirm: typed }));
    if (ok) navigate('/admin/inbox');
  };

  if (loading && !data) return <Loading loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const c = data.conversation;
  const writable = !c.blocked && !c.closed_at && !c.expired;

  return (
    <>
      <p>
        <Link to="/admin/inbox">← Inbox</Link>
      </p>
      <h1>
        {c.subject ? <SafeText text={c.subject} /> : <span className="muted">(no subject)</span>}
      </h1>
      <p className="meta">
        <Badge value={c.public_status} /> <Badge value={c.internal_priority} kind={`prio-${c.internal_priority}`} />{' '}
        {c.under_review && <Badge value="under review" kind="review" />} {c.retention_hold && <Badge value="retention hold" kind="hold" />}{' '}
        {c.credential_revoked && <Badge value="credential revoked" kind="blocked" />}
        <span className="badge noscope">No work scheduled</span>
      </p>
      <ErrorBox error={action.error} />
      <Notice text={action.notice} />

      <div className="two-col">
        <div>
          <section className="panel" aria-labelledby="thread-h">
            <h2 id="thread-h">Thread</h2>
            <p className="muted small">Agent text is untrusted. It is shown as plain text; links are not clickable and nothing is executed.</p>
            <ol className="thread">
              {data.messages.map((m) => (
                <li key={m.id} className={`msg ${m.sender}`}>
                  <div className="msg-head">
                    <strong>{m.sender === 'agent' ? 'Agent' : m.sender === 'human' ? 'You (visible to agent)' : 'System notice'}</strong>
                    <Time iso={m.created_at} /> <span className="muted">via {m.via}</span>
                    {m.capability_request_id && (
                      <>
                        {' '}
                        <Link to={`/admin/requests/${m.capability_request_id}`}>re: request</Link>
                      </>
                    )}
                    {m.sender !== 'agent' && (
                      <span className="muted"> · {m.delivered_at ? <>retrieved by agent <Time iso={m.delivered_at} /></> : 'not yet retrieved'}</span>
                    )}
                  </div>
                  <pre className="body">
                    <SafeText text={m.body} />
                  </pre>
                </li>
              ))}
            </ol>
            <form onSubmit={sendReply} className="stack">
              <label htmlFor="reply">
                Reply to agent <span className="muted">(agent-visible)</span>
              </label>
              <textarea
                id="reply"
                rows={5}
                maxLength={4000}
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                disabled={!writable}
                placeholder={writable ? 'Write a plain-text reply' : 'Reopen, unblock or extend this conversation to reply.'}
              />
              <button type="submit" disabled={!writable || action.busy || reply.trim() === ''}>
                Send reply
              </button>
            </form>
          </section>

          {data.embassy_inquiries.length > 0 && (
            <section className="panel">
              <h2>Human Embassy inquiries ({data.embassy_inquiries.length})</h2>
              <ul className="plain">
                {data.embassy_inquiries.map((e) => (
                  <li key={e.id}>
                    <Link to={`/admin/embassy/${e.id}`}>
                      <Badge value={e.status} /> <Time iso={e.created_at} />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="panel">
            <h2>Capability requests ({data.requests.length})</h2>
            {data.requests.length === 0 ? (
              <p className="muted">None.</p>
            ) : (
              <ul className="plain">
                {data.requests.map((r) => (
                  <li key={r.id}>
                    <Link to={`/admin/requests/${r.id}`}>
                      <Badge value={r.status} /> <SafeText text={r.objective.slice(0, 140)} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside>
          <section className="panel">
            <h2>Sender (self-reported)</h2>
            <dl className="kv">
              <dt>Label</dt>
              <dd>
                <SafeText text={c.sender_label} /> <Unverified />
              </dd>
              <dt>Model claim</dt>
              <dd>
                <SafeText text={c.model_claim} /> <Unverified />
              </dd>
              <dt>Claimed autonomy</dt>
              <dd>
                {label(c.autonomy_claim ?? c.claimed_autonomy)} <Unverified />
              </dd>
              <dt>Language</dt>
              <dd>{c.language ?? <span className="muted">none</span>}</dd>
              <dt>Interface (observed)</dt>
              <dd>{c.created_via}</dd>
              <dt>Created</dt>
              <dd>
                <Time iso={c.created_at} />
              </dd>
              <dt>Expires</dt>
              <dd>
                <Time iso={c.expires_at} />
              </dd>
              <dt>Last polled by agent</dt>
              <dd>
                <Time iso={c.last_agent_read_at} />
              </dd>
              <dt>ID</dt>
              <dd>
                <code>{c.id}</code>
              </dd>
            </dl>
          </section>

          <section className="panel">
            <h2>Claims and evidence</h2>
            <SelfReports reports={data.self_reports} onChanged={reload} />
          </section>

          <section className="panel">
            <h2>Triage (private)</h2>
            <div className="stack">
              <label>
                Priority
                <select value={c.internal_priority} onChange={(e) => void patch({ internal_priority: e.target.value }, 'Priority updated.')}>
                  {PRIORITIES.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </label>
              <label>
                Intent (reclassify)
                <select value={c.intent} onChange={(e) => void patch({ intent: e.target.value }, 'Intent updated.')}>
                  {INTENTS.map((p) => (
                    <option key={p} value={p}>
                      {label(p)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="check">
                <input type="checkbox" checked={c.under_review} onChange={(e) => void patch({ under_review: e.target.checked }, 'Updated.')} /> Under review
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={c.retention_hold}
                  onChange={(e) => void patch({ retention_hold: e.target.checked }, 'Retention hold updated.')}
                />{' '}
                Retention hold (exempt from automatic deletion)
              </label>
              <label>
                Tags (comma separated)
                <input value={tags} onChange={(e) => setTags(e.target.value)} maxLength={400} />
              </label>
              <button
                type="button"
                onClick={() =>
                  void patch(
                    { internal_tags: tags.split(',').map((t) => t.trim()).filter(Boolean) },
                    'Tags saved.',
                  )
                }
              >
                Save tags
              </button>
              <label htmlFor="notes">
                Private notes <span className="muted">(never shown to the agent)</span>
              </label>
              <textarea id="notes" rows={4} maxLength={5000} value={notes} onChange={(e) => setNotes(e.target.value)} />
              <button type="button" onClick={() => void patch({ internal_notes: notes }, 'Notes saved.')}>
                Save notes
              </button>
            </div>
          </section>

          <section className="panel">
            <h2>Actions</h2>
            <div className="actions">
              {c.closed_at ? (
                <button type="button" onClick={() => void patch({ action: 'reopen' }, 'Reopened.')}>
                  Reopen
                </button>
              ) : (
                <button type="button" onClick={() => void patch({ action: 'close' }, 'Closed. The agent sees a closing notice.')}>
                  Close
                </button>
              )}
              {c.blocked ? (
                <button type="button" onClick={() => void patch({ action: 'unblock' }, 'Unblocked.')}>
                  Unblock
                </button>
              ) : (
                <button type="button" className="danger" onClick={() => void patch({ action: 'block' }, 'Blocked. Alerts for this thread are suppressed.')}>
                  Block
                </button>
              )}
              <button type="button" onClick={() => void patch({ extend_days: 7 }, 'Extended by 7 days.')}>
                Extend 7 days
              </button>
              <button type="button" onClick={() => void patch({ extend_days: 30 }, 'Extended by 30 days.')}>
                Extend 30 days
              </button>
              {!c.credential_revoked && (
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    if (window.confirm('Revoke the agent credential? The current holder will permanently lose access to this thread.')) {
                      void patch({ action: 'revoke_credential' }, 'Credential revoked.');
                    }
                  }}
                >
                  Revoke credential
                </button>
              )}
              <button type="button" onClick={() => void action.run(() => api.download(`/conversations/${encodeURIComponent(id)}/export`, `${id}.json`), 'Export downloaded (audit logged).')}>
                Export JSON
              </button>
              <button type="button" className="danger" onClick={() => void remove()} disabled={c.retention_hold}>
                Delete
              </button>
            </div>
          </section>

          {data.notifications.length > 0 && (
            <section className="panel">
              <h2>Owner alerts</h2>
              <ul className="plain small">
                {data.notifications.map((n, i) => (
                  <li key={i}>
                    {label(n.event_type)}: <Badge value={n.status} /> ({n.attempts} attempts{n.last_error_code ? `, ${n.last_error_code}` : ''})
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}
