import { useEffect, useState } from 'react';
import { api, qs, type Page } from '../api';
import { ErrorBox, Loading, Time } from '../ui';

interface AuditItem {
  id: string;
  admin_subject: string;
  action: string;
  target_type: string;
  target_id: string | null;
  metadata: unknown;
  created_at: string;
}

export function Audit() {
  const [action, setAction] = useState('');
  const [target, setTarget] = useState('');
  const [items, setItems] = useState<AuditItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (append: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const page = await api.get<Page<AuditItem>>(`/audit${qs({ action: action.trim(), target_id: target.trim(), cursor: append ? cursor : null })}`);
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

  return (
    <>
      <h1>Audit log</h1>
      <p className="muted">Owner actions and system jobs. Message content is never recorded here.</p>
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          void load(false);
        }}
      >
        <label>
          Action
          <input value={action} onChange={(e) => setAction(e.target.value)} placeholder="e.g. conversation.reply" maxLength={64} />
        </label>
        <label>
          Target id
          <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="conv_… or cap_…" maxLength={64} />
        </label>
        <button type="submit">Apply</button>
        <a href={`/admin/api/audit${qs({ format: 'csv', action: action.trim(), target_id: target.trim() })}`} download>
          Export CSV
        </a>
      </form>
      <ErrorBox error={error} />
      {items && items.length === 0 && <p className="empty">No audit events.</p>}
      {items && items.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Target</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <td>
                    <Time iso={a.created_at} />
                  </td>
                  <td>{a.admin_subject}</td>
                  <td>
                    <code>{a.action}</code>
                  </td>
                  <td>
                    {a.target_type} {a.target_id && <code>{a.target_id}</code>}
                  </td>
                  <td>
                    <code className="small">{a.metadata ? JSON.stringify(a.metadata) : ''}</code>
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
