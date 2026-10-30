import { api } from '../api';
import { ErrorBox, Link, Loading, label, useLoad } from '../ui';

type Counts = Record<string, number>;
interface Metrics {
  generated_at: string;
  evidence_note: string;
  observed: {
    conversations: {
      total: number;
      last_24h: number;
      last_7d: number;
      active: number;
      blocked: number;
      awaiting_owner: number;
      by_interface: Counts;
      by_status: Counts;
    };
    two_way: {
      human_replies_total: number;
      human_replies_retrieved_by_agent: number;
      conversations_with_round_trip: number;
      conversations_with_agent_follow_up: number;
    };
    capability_requests: { by_status: Counts; by_category_hint: Counts; by_interface: Counts };
    human_response_minutes_median_30d: number | null;
    abuse_events_last_7d: Counts;
    notifications_by_status: Counts;
  };
  claimed: { unverified: true; claimed_autonomy: Counts };
}

function CountTable({ title, counts, note }: { title: string; counts: Counts; note?: string }) {
  const entries = Object.entries(counts);
  return (
    <section className="panel">
      <h3>{title}</h3>
      {note && <p className="muted small">{note}</p>}
      {entries.length === 0 ? (
        <p className="muted">No data yet.</p>
      ) : (
        <table className="compact">
          <tbody>
            {entries.map(([k, v]) => (
              <tr key={k}>
                <th scope="row">{label(k)}</th>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function Overview() {
  const { data, error, loading } = useLoad(() => api.get<Metrics>('/metrics'), []);
  const o = data?.observed;
  const openRequests = o
    ? ['submitted', 'triaging', 'clarification_requested', 'needs_authorization'].reduce(
        (n, s) => n + (o.capability_requests.by_status[s] ?? 0),
        0,
      )
    : 0;
  const dead = o?.notifications_by_status['dead'] ?? 0;
  return (
    <>
      <h1>Overview</h1>
      <Loading loading={loading} />
      <ErrorBox error={error} />
      {data && o && (
        <>
          {dead > 0 && (
            <p className="warning" role="alert">
              {dead} owner alert(s) failed permanently. Check notification settings; inquiries are safe in the inbox.
            </p>
          )}
          <div className="tiles">
            <Link to="/admin/inbox?status=active" className="tile">
              <strong>{o.conversations.awaiting_owner}</strong>
              <span>awaiting your reply</span>
            </Link>
            <Link to="/admin/requests" className="tile">
              <strong>{openRequests}</strong>
              <span>requests under review</span>
            </Link>
            <div className="tile">
              <strong>{o.conversations.last_24h}</strong>
              <span>new inquiries (24h)</span>
            </div>
            <div className="tile">
              <strong>{o.two_way.conversations_with_round_trip}</strong>
              <span>round trips (reply retrieved)</span>
            </div>
            <div className="tile">
              <strong>{o.human_response_minutes_median_30d === null ? 'n/a' : `${Math.round(o.human_response_minutes_median_30d)} min`}</strong>
              <span>median first response (30d)</span>
            </div>
          </div>
          <p className="muted small">{data.evidence_note}</p>
          <div className="grid">
            <CountTable title="Conversations by status (observed)" counts={o.conversations.by_status} />
            <CountTable title="First contact by interface (observed)" counts={o.conversations.by_interface} />
            <CountTable title="Requests by status (observed)" counts={o.capability_requests.by_status} />
            <CountTable title="Requests by category hint (observed)" counts={o.capability_requests.by_category_hint} />
            <CountTable
              title="Claimed autonomy (UNVERIFIED self-report)"
              counts={data.claimed.claimed_autonomy}
              note="What senders said about themselves. Not evidence of autonomy, identity or independence."
            />
            <CountTable title="Abuse signals, last 7 days" counts={o.abuse_events_last_7d} />
            <CountTable title="Owner alerts by status" counts={o.notifications_by_status} />
          </div>
          <p>
            <a href="/admin/api/metrics?format=csv" download>
              Download aggregate metrics (CSV)
            </a>
          </p>
        </>
      )}
    </>
  );
}
