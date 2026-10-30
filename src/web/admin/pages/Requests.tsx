import { useEffect, useState } from 'react';
import { api, qs, type AdminRequest, type Page } from '../api';
import { Badge, ErrorBox, Link, Loading, SafeText, Time, label } from '../ui';

const STATUSES = ['open', 'submitted', 'triaging', 'clarification_requested', 'needs_authorization', 'eligible_for_future_scoping', 'declined', 'withdrawn', ''];

export function Requests() {
  const [status, setStatus] = useState('open');
  const [category, setCategory] = useState('');
  const [via, setVia] = useState('');
  const [items, setItems] = useState<AdminRequest[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (append: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const page = await api.get<Page<AdminRequest>>(
        `/capability-requests${qs({ status, category: category.trim(), via, cursor: append ? cursor : null })}`,
      );
      setItems((prev) => (append && prev ? [...prev, ...page.items] : page.items));
      setCursor(page.next_cursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load.');
    } finally {
      setLoading(false);
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void load(false), [status, via]);

  return (
    <>
      <h1>Capability requests</h1>
      <p className="muted">Proposals awaiting human review. No decision here schedules, prices or authorizes work.</p>
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          void load(false);
        }}
      >
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s ? label(s) : 'any'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Category hint
          <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. human_eyes or unclassified" maxLength={64} />
        </label>
        <label>
          Interface
          <select value={via} onChange={(e) => setVia(e.target.value)}>
            <option value="">any</option>
            <option value="rest">REST</option>
            <option value="mcp">MCP</option>
          </select>
        </label>
        <button type="submit">Apply</button>
      </form>
      <ErrorBox error={error} />
      {items && items.length === 0 && <p className="empty">No requests in this view.</p>}
      {items && items.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Submitted</th>
                <th>Objective</th>
                <th>Category hint</th>
                <th>Status</th>
                <th>Conversation</th>
                <th>Via</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Time iso={r.created_at} />
                  </td>
                  <td>
                    <Link to={`/admin/requests/${r.id}`}>
                      <SafeText text={r.objective.length > 160 ? `${r.objective.slice(0, 160)}…` : r.objective} />
                    </Link>
                  </td>
                  <td>{r.category_hint ? <SafeText text={r.category_hint} /> : <span className="muted">unclassified</span>}</td>
                  <td>
                    <Badge value={r.status} />
                  </td>
                  <td>
                    <Link to={`/admin/conversations/${r.conversation_id}`}>
                      {r.conversation?.subject ? <SafeText text={r.conversation.subject} /> : r.conversation_id}
                    </Link>
                  </td>
                  <td>{r.created_via}</td>
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
