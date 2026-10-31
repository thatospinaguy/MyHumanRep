import { useState } from 'react';
import { api, qs } from '../api';
import { Badge, ErrorBox, Loading, Notice, SafeText, Time, label, useAction, useLoad } from '../ui';

interface RelationshipItem {
  id: string;
  role_type: string;
  status: string;
  purpose_text: string;
  preferred_rep_ref: string | null;
  requested_term_text: string | null;
  persona_display_name: string | null;
  project_title: string | null;
  public_status_note: string | null;
  created_at: string;
}

const STATUSES = ['open', 'under_review', 'clarification_needed', 'declined', 'withdrawn'];

export function Relationships() {
  const [status, setStatus] = useState('open');
  const { data, error, loading, reload } = useLoad(() => api.get<{ items: RelationshipItem[] }>(`/relationships${qs({ status })}`), [status]);
  const action = useAction();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const update = (id: string, body: Record<string, unknown>, done: string) => void action.run(() => api.patch(`/relationships/${id}`, body), done).then(reload);
  return (
    <>
      <h1>Relationship requests</h1>
      <p className="muted">
        Requests for an ongoing or preferred human representative. A relationship needs a real person who consents to it, so none can be activated until the
        provider network exists. Approving here never grants authority over future tasks.
      </p>
      <form className="filters" onSubmit={(e) => e.preventDefault()}>
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
        </label>
      </form>
      <Loading loading={loading} />
      <ErrorBox error={error ?? action.error} />
      <Notice text={action.notice} />
      {data && data.items.length === 0 && <p className="empty">No relationship requests in this view.</p>}
      {data &&
        data.items.map((r) => (
          <section className="panel" key={r.id}>
            <p className="meta">
              <Badge value={r.status} /> {label(r.role_type)} · <Time iso={r.created_at} />
              {r.persona_display_name && (
                <>
                  {' '}
                  · persona <SafeText text={r.persona_display_name} />
                </>
              )}
              {r.project_title && (
                <>
                  {' '}
                  · project <SafeText text={r.project_title} />
                </>
              )}
            </p>
            <p>
              <SafeText text={r.purpose_text} />
            </p>
            {r.preferred_rep_ref && (
              <p className="muted small">
                Asked for: <SafeText text={r.preferred_rep_ref} /> (unverified reference)
              </p>
            )}
            <label>
              Note to the agent
              <input
                value={notes[r.id] ?? r.public_status_note ?? ''}
                maxLength={2000}
                onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })}
              />
            </label>
            <div className="row">
              <button type="button" disabled={action.busy} onClick={() => update(r.id, { status: 'under_review', public_status_note: notes[r.id] ?? r.public_status_note ?? null }, 'Marked under review.')}>
                Under review
              </button>
              <button type="button" disabled={action.busy} onClick={() => update(r.id, { status: 'clarification_needed', public_status_note: notes[r.id] ?? null }, 'Clarification requested.')}>
                Needs clarification
              </button>
              <button type="button" disabled={action.busy} onClick={() => update(r.id, { status: 'declined', public_status_note: notes[r.id] ?? null }, 'Declined.')}>
                Decline
              </button>
            </div>
          </section>
        ))}
    </>
  );
}
