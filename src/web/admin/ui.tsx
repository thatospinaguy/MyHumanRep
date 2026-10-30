import { useCallback, useEffect, useState, type ReactNode, type MouseEvent } from 'react';
import { ApiFailure } from './api';

// ---------- Router ----------

const listeners = new Set<() => void>();

export function navigate(path: string): void {
  if (path === window.location.pathname + window.location.search) return;
  window.history.pushState(null, '', path);
  listeners.forEach((l) => l());
}

export function usePath(): string {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    listeners.add(update);
    window.addEventListener('popstate', update);
    return () => {
      listeners.delete(update);
      window.removeEventListener('popstate', update);
    };
  }, []);
  return path;
}

export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} onClick={onClick} className={className}>
      {children}
    </a>
  );
}

// ---------- Untrusted text ----------

const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * Renders untrusted agent text as inert plain text. React escapes everything;
 * bidirectional control characters are additionally shown as visible markers so
 * they cannot reorder what the owner reads.
 */
export function SafeText({ text, className }: { text: string | null | undefined; className?: string }) {
  if (text === null || text === undefined || text === '') return <span className="muted">none</span>;
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(BIDI)) {
    if (m.index! > last) parts.push(text.slice(last, m.index));
    parts.push(
      <span key={m.index} className="ctl" title="Bidirectional control character">
        {`[U+${m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}]`}
      </span>,
    );
    last = m.index! + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <span className={`untrusted ${className ?? ''}`}>{parts}</span>;
}

// ---------- Data loading ----------

export function useLoad<T>(loader: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(loader, deps);
  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    run()
      .then((d) => setData(d))
      .catch((e: unknown) => setError(e instanceof ApiFailure || e instanceof Error ? e.message : 'Failed to load.'))
      .finally(() => setLoading(false));
  }, [run]);
  useEffect(reload, [reload]);
  return { data, error, loading, reload, setData };
}

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (success) setNotice(success);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed.');
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, notice, run };
}

// ---------- Small components ----------

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="error" role="alert">
      {error}
    </p>
  );
}

export function Notice({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p className="ok" role="status">
      {text}
    </p>
  );
}

export function Badge({ value, kind }: { value: string; kind?: string }) {
  return <span className={`badge ${kind ?? value}`}>{value.replace(/_/g, ' ')}</span>;
}

export function Time({ iso }: { iso: string | null | undefined }) {
  if (!iso) return <span className="muted">never</span>;
  const d = new Date(iso);
  return (
    <time dateTime={iso} title={`${iso} (UTC)`}>
      {d.toLocaleString()}
    </time>
  );
}

export function Unverified() {
  return <span className="badge unverified">unverified claim</span>;
}

export function Loading({ loading }: { loading: boolean }) {
  return loading ? (
    <p className="muted" aria-live="polite">
      Loading…
    </p>
  ) : null;
}

export const label = (v: string) => v.replace(/_/g, ' ');
