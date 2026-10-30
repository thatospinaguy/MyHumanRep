import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { ErrorBox, Loading, Notice, useAction, useLoad } from '../ui';

interface SettingsResponse {
  settings: {
    intake_enabled: boolean;
    intake_paused_message: string;
    conversation_ttl_days: number;
    expired_grace_days: number;
    abuse_retention_days: number;
    audit_retention_days: number;
    notifications_enabled: boolean;
    first_contact_per_source_per_hour: number;
    first_contact_global_per_day: number;
  };
  read_only: Record<string, unknown>;
}

type S = SettingsResponse['settings'];
const NUMBER_FIELDS: Array<[keyof S, string, number, number]> = [
  ['conversation_ttl_days', 'Conversation lifetime (days)', 1, 365],
  ['expired_grace_days', 'Delete expired conversations after (days)', 0, 90],
  ['abuse_retention_days', 'Abuse signal retention (days)', 1, 90],
  ['audit_retention_days', 'Audit retention (days)', 7, 730],
  ['first_contact_per_source_per_hour', 'First contacts per source per hour', 1, 100000],
  ['first_contact_global_per_day', 'First contacts per day (global)', 1, 1000000],
];

export function Settings({ onChanged }: { onChanged: () => void }) {
  const { data, error, loading, reload } = useLoad(() => api.get<SettingsResponse>('/settings'), []);
  const action = useAction();
  const [form, setForm] = useState<S | null>(null);
  useEffect(() => {
    if (data) setForm(data.settings);
  }, [data]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!form || !data) return;
    const changed = Object.fromEntries(Object.entries(form).filter(([k, v]) => data.settings[k as keyof S] !== v));
    if (Object.keys(changed).length === 0) return;
    const ok = await action.run(() => api.patch('/settings', changed), 'Settings saved (audit logged).');
    if (ok) {
      reload();
      onChanged();
    }
  };

  if (loading && !form) return <Loading loading />;
  if (error) return <ErrorBox error={error} />;
  if (!form || !data) return null;

  return (
    <>
      <h1>Settings</h1>
      <ErrorBox error={action.error} />
      <Notice text={action.notice} />
      <form onSubmit={save} className="panel stack narrow">
        <h2>Public intake</h2>
        <label className="check">
          <input type="checkbox" checked={form.intake_enabled} onChange={(e) => setForm({ ...form, intake_enabled: e.target.checked })} /> Accept new
          inquiries (existing conversations always continue)
        </label>
        <label>
          Message shown to agents while paused
          <input
            value={form.intake_paused_message}
            maxLength={300}
            onChange={(e) => setForm({ ...form, intake_paused_message: e.target.value })}
          />
        </label>
        <h2>Notifications</h2>
        <label className="check">
          <input
            type="checkbox"
            checked={form.notifications_enabled}
            onChange={(e) => setForm({ ...form, notifications_enabled: e.target.checked })}
          />{' '}
          Send owner alerts (provider: {String(data.read_only['notify_provider'])}
          {data.read_only['notify_to_configured'] ? '' : ', no recipient configured'})
        </label>
        <h2>Retention and limits</h2>
        {NUMBER_FIELDS.map(([key, text, min, max]) => (
          <label key={key}>
            {text}
            <input
              type="number"
              min={min}
              max={max}
              value={form[key] as number}
              onChange={(e) => setForm({ ...form, [key]: Number(e.target.value) })}
            />
          </label>
        ))}
        <p className="muted small">The public privacy page and capability document reflect these values automatically.</p>
        <button type="submit" disabled={action.busy}>
          Save settings
        </button>
      </form>
      <section className="panel narrow">
        <h2>Deployment configuration (read only)</h2>
        <p className="muted small">Secrets are never shown here. Change these with Wrangler configuration and secrets.</p>
        <pre className="body">{JSON.stringify(data.read_only, null, 2)}</pre>
      </section>
    </>
  );
}
