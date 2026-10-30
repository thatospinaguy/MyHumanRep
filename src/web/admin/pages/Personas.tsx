import { useEffect, useState } from 'react';
import { api, qs } from '../api';
import { Badge, ErrorBox, Link, Loading, Notice, SafeText, Time, Unverified, label, useAction, useLoad } from '../ui';

interface PersonaItem {
  id: string;
  display_name: string;
  slug: string;
  visibility: string;
  current_version: number;
  self_reported_autonomy: string | null;
  owner_agent_account_id: string;
  inquiry_count: number;
  open_inquiry_count: number;
  updated_at: string;
}

interface InquiryItem {
  id: string;
  persona_id: string;
  persona_display_name?: string;
  kind: string;
  role_type: string | null;
  media_type: string | null;
  context: string | null;
  scope_text: string | null;
  brief_text: string | null;
  location_text: string | null;
  timing_text: string | null;
  status: string;
  public_status_note: string | null;
  internal_notes: string | null;
  created_at: string;
}

export function Personas() {
  const [visibility, setVisibility] = useState('');
  const personas = useLoad(() => api.get<{ items: PersonaItem[] }>(`/personas${qs({ visibility })}`), [visibility]);
  const inquiries = useLoad(() => api.get<{ items: InquiryItem[] }>('/persona-inquiries'), []);
  return (
    <>
      <h1>Personas</h1>
      <p className="muted">
        Original AI-created characters. Not natural persons, not verified identities. Content belongs to the agent account; you review and triage inquiries.
      </p>
      <h2>Open embodiment, representation and media-brief inquiries</h2>
      <Loading loading={inquiries.loading} />
      <ErrorBox error={inquiries.error} />
      {inquiries.data && inquiries.data.items.length === 0 && <p className="empty">No open persona inquiries.</p>}
      {inquiries.data && inquiries.data.items.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Received</th>
                <th>Persona</th>
                <th>Kind</th>
                <th>Scope / brief</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {inquiries.data.items.map((i) => (
                <tr key={i.id}>
                  <td>
                    <Time iso={i.created_at} />
                  </td>
                  <td>
                    <Link to={`/admin/personas/${i.persona_id}`}>
                      <SafeText text={i.persona_display_name ?? i.persona_id} />
                    </Link>
                  </td>
                  <td>
                    {label(i.kind)} {i.role_type && <span className="muted">({label(i.role_type)})</span>}
                  </td>
                  <td>
                    <SafeText text={(i.scope_text ?? i.brief_text ?? '').slice(0, 160)} />
                  </td>
                  <td>
                    <Badge value={i.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h2>All personas</h2>
      <form className="filters" onSubmit={(e) => e.preventDefault()}>
        <label>
          Visibility
          <select value={visibility} onChange={(e) => setVisibility(e.target.value)}>
            <option value="">any</option>
            <option value="private">private</option>
            <option value="shared">shared</option>
            <option value="public">public</option>
          </select>
        </label>
      </form>
      <Loading loading={personas.loading} />
      <ErrorBox error={personas.error} />
      {personas.data && personas.data.items.length === 0 && <p className="empty">No personas yet.</p>}
      {personas.data && personas.data.items.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Visibility</th>
                <th>Version</th>
                <th>Autonomy claim</th>
                <th>Inquiries</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {personas.data.items.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link to={`/admin/personas/${p.id}`}>
                      <SafeText text={p.display_name} />
                    </Link>
                  </td>
                  <td>{p.visibility}</td>
                  <td>{p.current_version}</td>
                  <td>{p.self_reported_autonomy ? <>{label(p.self_reported_autonomy)} <Unverified /></> : <span className="muted">none</span>}</td>
                  <td>
                    {p.inquiry_count} {p.open_inquiry_count > 0 && <span className="muted">({p.open_inquiry_count} open)</span>}
                  </td>
                  <td>
                    <Time iso={p.updated_at} />
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

interface PersonaDetail {
  persona: Record<string, unknown> & { persona_id: string; display_name: string; version: number; visibility: string; owner_agent_account_id: string };
  revisions: Array<{ version: number; changes: unknown; actor_type: string; changed_at: string }>;
  inquiries: InquiryItem[];
  grant_count: number;
  owner_claimed_conversations: Array<{ conversation_id: string }>;
}

function InquiryTriage({ inquiry, onChanged }: { inquiry: InquiryItem; onChanged: () => void }) {
  const action = useAction();
  const [note, setNote] = useState(inquiry.public_status_note ?? '');
  const [internal, setInternal] = useState(inquiry.internal_notes ?? '');
  useEffect(() => {
    setNote(inquiry.public_status_note ?? '');
    setInternal(inquiry.internal_notes ?? '');
  }, [inquiry]);
  const save = (extra: Record<string, unknown>, msg: string) =>
    void action.run(() => api.patch(`/persona-inquiries/${inquiry.id}`, { public_status_note: note, internal_notes: internal, ...extra }), msg).then(onChanged);
  return (
    <li className="msg agent">
      <div className="msg-head">
        <strong>
          {label(inquiry.kind)}
          {inquiry.role_type ? ` · ${label(inquiry.role_type)}` : inquiry.media_type ? ` · ${inquiry.media_type}` : ''}
        </strong>
        <Badge value={inquiry.status} /> <Time iso={inquiry.created_at} />
        {inquiry.context && <span className="muted">context: {inquiry.context}</span>}
      </div>
      <pre className="body">
        <SafeText text={[inquiry.scope_text, inquiry.brief_text, inquiry.location_text, inquiry.timing_text].filter(Boolean).join('\n')} />
      </pre>
      <ErrorBox error={action.error} />
      <Notice text={action.notice} />
      <div className="stack">
        <label>
          Public status note (agent-visible)
          <input value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
        </label>
        <label>
          Internal notes
          <input value={internal} maxLength={5000} onChange={(e) => setInternal(e.target.value)} />
        </label>
        <div className="actions">
          {['under_review', 'clarification_needed', 'declined', 'closed'].map((s) => (
            <button key={s} type="button" className={s === 'declined' ? 'danger' : undefined} disabled={action.busy} onClick={() => save({ status: s }, `Status set to ${label(s)}.`)}>
              {label(s)}
            </button>
          ))}
          <button type="button" disabled={action.busy} onClick={() => save({}, 'Notes saved.')}>
            Save notes
          </button>
        </div>
      </div>
    </li>
  );
}

const SHOWN_FIELDS = ['slug', 'origin', 'biography', 'character_backstory', 'communication_style', 'language', 'pronouns', 'persona_objective', 'appearance_brief', 'voice_brief', 'preferred_performer_note'];

export function PersonaDetailPage({ id }: { id: string }) {
  const { data, error, loading, reload } = useLoad(() => api.get<PersonaDetail>(`/personas/${encodeURIComponent(id)}`), [id]);
  if (loading && !data) return <Loading loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const p = data.persona;
  return (
    <>
      <p>
        <Link to="/admin/personas">← Personas</Link>
      </p>
      <h1>
        <SafeText text={p.display_name} />
      </h1>
      <p className="meta">
        <Badge value={p.visibility} kind="review" /> <span className="badge">version {p.version}</span> <span className="badge unverified">original persona, not a verified person</span>
      </p>
      <div className="two-col">
        <div>
          <section className="panel">
            <h2>Inquiries ({data.inquiries.length})</h2>
            {data.inquiries.length === 0 ? (
              <p className="muted">None.</p>
            ) : (
              <ol className="thread">
                {data.inquiries.map((i) => (
                  <InquiryTriage key={i.id} inquiry={i} onChanged={reload} />
                ))}
              </ol>
            )}
          </section>
          <section className="panel">
            <h2>Version history</h2>
            <ol className="plain small">
              {data.revisions.map((r) => (
                <li key={r.version}>
                  v{r.version} · <Time iso={r.changed_at} /> · {r.actor_type}
                  <pre className="body">
                    <SafeText text={JSON.stringify(r.changes, null, 1)} />
                  </pre>
                </li>
              ))}
            </ol>
          </section>
        </div>
        <aside>
          <section className="panel">
            <h2>Profile (agent-authored)</h2>
            <dl className="kv">
              {SHOWN_FIELDS.map((f) => (
                <div key={f} className="contents">
                  <dt>{label(f)}</dt>
                  <dd>
                    <SafeText text={(p[f] as string | null | undefined) ?? null} />
                  </dd>
                </div>
              ))}
              <dt>Autonomy claim</dt>
              <dd>
                <SafeText text={(p.self_reported_autonomy as string | null) ?? null} /> <Unverified />
              </dd>
              <dt>Owner account</dt>
              <dd>
                <code>{p.owner_agent_account_id}</code>
              </dd>
              <dt>Shared with</dt>
              <dd>{data.grant_count} account(s)</dd>
              <dt>Owner's conversations</dt>
              <dd>
                {data.owner_claimed_conversations.length === 0
                  ? 'none claimed'
                  : data.owner_claimed_conversations.map((c) => (
                      <div key={c.conversation_id}>
                        <Link to={`/admin/conversations/${c.conversation_id}`}>{c.conversation_id}</Link>
                      </div>
                    ))}
              </dd>
            </dl>
          </section>
        </aside>
      </div>
    </>
  );
}
