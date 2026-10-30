import { useEffect, useState, type FormEvent } from 'react';
import { api, qs, type ConversationSummary, type Page } from '../api';
import { Badge, ErrorBox, Link, Loading, SafeText, Time, label } from '../ui';

const STATUSES = ['', 'active', 'waiting_for_human', 'human_replied', 'waiting_for_agent', 'closed', 'blocked', 'expired'];
const INTENTS = ['', 'general_inquiry', 'capability_request', 'research_question', 'other'];
const PRIORITIES = ['', 'urgent', 'high', 'normal', 'low'];

interface Filters {
  status: string;
  intent: string;
  priority: string;
  has_requests: string;
  from: string;
  to: string;
  q: string;
}

function initialFilters(): Filters {
  const sp = new URLSearchParams(window.location.search);
  return {
    status: sp.get('status') ?? '',
    intent: sp.get('intent') ?? '',
    priority: '',
    has_requests: '',
    from: '',
    to: '',
    q: '',
  };
}

export function Inbox() {
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [items, setItems] = useState<ConversationSummary[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (append: boolean, f: Filters = filters) => {
    setLoading(true);
    setError(null);
    try {
      const base = { status: f.status, intent: f.intent, priority: f.priority, has_requests: f.has_requests, from: f.from, to: f.to };
      const after = append ? cursor : null;
      // Free-text search goes in a POST body so it never appears in URLs or access logs.
      const page = f.q.trim()
        ? await api.post<Page<ConversationSummary>>('/conversations/search', {
            ...Object.fromEntries(Object.entries(base).filter(([, v]) => v)),
            q: f.q.trim(),
            ...(after ? { cursor: after } : {}),
          })
        : await api.get<Page<ConversationSummary>>(`/conversations${qs({ ...base, cursor: after })}`);
      setItems((prev) => (append && prev ? [...prev, ...page.items] : page.items));
      setCursor(page.next_cursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load.');
    } finally {
      setLoading(false);
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void load(false), []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void load(false);
  };
  const set = (k: keyof Filters) => (e: { target: { value: string } }) => setFilters({ ...filters, [k]: e.target.value });

  return (
    <>
      <h1>Inbox</h1>
      <form className="filters" onSubmit={submit} role="search" aria-label="Filter conversations">
        <label>
          Search
          <input type="search" value={filters.q} onChange={set('q')} maxLength={200} placeholder="subject, label, message text" />
        </label>
        <label>
          Status
          <select value={filters.status} onChange={set('status')}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s ? label(s) : 'any'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Intent
          <select value={filters.intent} onChange={set('intent')}>
            {INTENTS.map((s) => (
              <option key={s} value={s}>
                {s ? label(s) : 'any'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Priority
          <select value={filters.priority} onChange={set('priority')}>
            {PRIORITIES.map((s) => (
              <option key={s} value={s}>
                {s || 'any'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Requests
          <select value={filters.has_requests} onChange={set('has_requests')}>
            <option value="">any</option>
            <option value="true">has requests</option>
            <option value="false">no requests</option>
          </select>
        </label>
        <label>
          From
          <input type="date" value={filters.from} onChange={set('from')} />
        </label>
        <label>
          To
          <input type="date" value={filters.to} onChange={set('to')} />
        </label>
        <button type="submit" disabled={loading}>
          Apply
        </button>
      </form>
      <ErrorBox error={error} />
      {items && items.length === 0 && <p className="empty">No conversations match. New inquiries appear here.</p>}
      {items && items.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Received</th>
                <th>Subject</th>
                <th>Sender label (claimed)</th>
                <th>Intent</th>
                <th>Status</th>
                <th>Msgs</th>
                <th>Updated</th>
                <th>Requests</th>
                <th>Priority / tags</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id} className={c.awaiting_owner ? 'unread' : undefined}>
                  <td>
                    <Time iso={c.created_at} />
                  </td>
                  <td>
                    <Link to={`/admin/conversations/${c.id}`}>
                      {c.subject ? <SafeText text={c.subject} /> : <span className="muted">(no subject)</span>}
                    </Link>
                    {c.awaiting_owner && <span className="dot" aria-label="awaiting reply" />}
                  </td>
                  <td>
                    <SafeText text={c.sender_label} />
                  </td>
                  <td>{label(c.intent)}</td>
                  <td>
                    <Badge value={c.public_status} />
                  </td>
                  <td>{c.message_count}</td>
                  <td>
                    <Time iso={c.updated_at} />
                  </td>
                  <td>
                    {c.request_count}
                    {c.open_request_count > 0 && <span className="muted"> ({c.open_request_count} open)</span>}
                  </td>
                  <td>
                    <Badge value={c.internal_priority} kind={`prio-${c.internal_priority}`} />{' '}
                    {c.internal_tags.map((t) => (
                      <span key={t} className="tag">
                        {t}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Loading loading={loading} />
      {cursor && !loading && (
        <button type="button" onClick={() => void load(true)}>
          Load more
        </button>
      )}
    </>
  );
}
