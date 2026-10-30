import { useState } from 'react';
import { api } from '../api';
import { Badge, ErrorBox, Link, Loading, Notice, SafeText, Time, label, useAction, useLoad } from '../ui';

interface Capability {
  slug: string;
  number: number | null;
  display_name: string;
  summary: string;
  readiness: string;
  inquiry_enabled: number;
  risk_tier: string;
  origin: string;
  request_count: number;
}

interface Registry {
  capabilities: Capability[];
  aliases: Array<{ slug: string; name: string; maps_to: string[] }>;
  pending_candidates: number;
  unclassified_requests: number;
}

interface Candidate {
  id: string;
  request_id: string;
  conversation_id: string;
  suggested_label: string | null;
  normalized_key: string | null;
  objective: string;
  created_at: string;
}

const READINESS = ['inquiry_only', 'human_reviewed_inquiry', 'pilot', 'live', 'future'];

function CandidateRow({ c, capabilities, onDone }: { c: Candidate; capabilities: Capability[]; onDone: () => void }) {
  const action = useAction();
  const [target, setTarget] = useState(capabilities[0]?.slug ?? '');
  const [name, setName] = useState(c.suggested_label ?? '');
  const [slug, setSlug] = useState(c.normalized_key ?? '');
  const [summary, setSummary] = useState('');
  const decide = (body: Record<string, unknown>, msg: string) => void action.run(() => api.post(`/candidate-capabilities/${c.id}/decision`, body), msg).then((ok) => ok && onDone());
  return (
    <li className="msg agent">
      <div className="msg-head">
        <strong>
          <SafeText text={c.suggested_label} />
        </strong>
        <Time iso={c.created_at} /> <Link to={`/admin/conversations/${c.conversation_id}`}>conversation</Link>
      </div>
      <pre className="body">
        <SafeText text={c.objective} />
      </pre>
      <ErrorBox error={action.error} />
      <Notice text={action.notice} />
      <div className="filters">
        <label>
          Merge into
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            {capabilities.map((cap) => (
              <option key={cap.slug} value={cap.slug}>
                {cap.display_name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" disabled={action.busy} onClick={() => decide({ action: 'merge', capability_slug: target }, 'Merged.')}>
          Merge
        </button>
        <button type="button" className="danger" disabled={action.busy} onClick={() => decide({ action: 'reject' }, 'Rejected.')}>
          Reject
        </button>
      </div>
      <details>
        <summary>Accept as a new inquiry-only capability (rename here)</summary>
        <div className="stack">
          <label>
            Name
            <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Slug
            <input value={slug} maxLength={64} onChange={(e) => setSlug(e.target.value)} />
          </label>
          <label>
            Public summary
            <textarea rows={2} maxLength={600} value={summary} onChange={(e) => setSummary(e.target.value)} />
          </label>
          <button type="button" disabled={action.busy || !name || !slug || !summary} onClick={() => decide({ action: 'accept', new_slug: slug, name, summary }, 'Accepted as inquiry-only.')}>
            Accept
          </button>
        </div>
      </details>
    </li>
  );
}

export function RegistryPage() {
  const registry = useLoad(() => api.get<Registry>('/capabilities'), []);
  const candidates = useLoad(() => api.get<{ items: Candidate[] }>('/candidate-capabilities'), []);
  const action = useAction();
  const reloadAll = () => {
    registry.reload();
    candidates.reload();
  };
  return (
    <>
      <h1>Capability registry</h1>
      <p className="muted">
        Public availability must be truthful: only set pilot or live when people, procedures and approvals actually exist. Every change is audited.
      </p>
      <ErrorBox error={action.error ?? registry.error ?? candidates.error} />
      <Notice text={action.notice} />
      <h2>
        Unfamiliar requests to review {registry.data && <Badge value={`${registry.data.pending_candidates} pending`} kind="review" />}{' '}
        {registry.data && <span className="muted small">{registry.data.unclassified_requests} unclassified requests overall (filter Requests by "unclassified")</span>}
      </h2>
      <Loading loading={candidates.loading} />
      {candidates.data && candidates.data.items.length === 0 && <p className="empty">No candidate labels waiting.</p>}
      {candidates.data && registry.data && candidates.data.items.length > 0 && (
        <ol className="thread">
          {candidates.data.items.map((c) => (
            <CandidateRow key={c.id} c={c} capabilities={registry.data!.capabilities} onDone={reloadAll} />
          ))}
        </ol>
      )}
      <h2>Capabilities</h2>
      <Loading loading={registry.loading} />
      {registry.data && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Capability</th>
                <th>Requests</th>
                <th>Risk</th>
                <th>Readiness</th>
              </tr>
            </thead>
            <tbody>
              {registry.data.capabilities.map((c) => (
                <tr key={c.slug}>
                  <td>{c.number ?? 'new'}</td>
                  <td>
                    <strong>{c.display_name}</strong> <code>{c.slug}</code>
                    <div className="muted small">{c.summary}</div>
                  </td>
                  <td>{c.request_count}</td>
                  <td>{c.risk_tier}</td>
                  <td>
                    <select
                      aria-label={`Readiness of ${c.display_name}`}
                      value={c.readiness}
                      onChange={(e) => {
                        const readiness = e.target.value;
                        if ((readiness === 'pilot' || readiness === 'live') && !window.confirm(`Mark ${c.display_name} as ${readiness}? Agents will be told fulfillment is available.`)) return;
                        void action.run(() => api.patch(`/capabilities/${c.slug}`, { readiness }), `${c.display_name}: ${label(readiness)}.`).then(registry.reload);
                      }}
                    >
                      {READINESS.map((r) => (
                        <option key={r} value={r}>
                          {label(r)}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {registry.data && (
        <>
          <h2>Alias families</h2>
          <ul className="plain small">
            {registry.data.aliases.map((a) => (
              <li key={a.slug}>
                <strong>{a.name}</strong> <code>{a.slug}</code>: {a.maps_to.join(', ')}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
