import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { api, type Session } from './api';
import { Audit } from './pages/Audit';
import { Conversation } from './pages/Conversation';
import { Embassy, EmbassyDetailPage } from './pages/Embassy';
import { PersonaDetailPage, Personas } from './pages/Personas';
import { RegistryPage } from './pages/Registry';
import { Inbox } from './pages/Inbox';
import { Overview } from './pages/Overview';
import { RequestDetail } from './pages/RequestDetail';
import { Requests } from './pages/Requests';
import { Settings } from './pages/Settings';
import { ErrorBox, Link, useLoad, usePath } from './ui';
import './styles.css';

const NAV: Array<[string, string]> = [
  ['/admin/', 'Overview'],
  ['/admin/inbox', 'Inbox'],
  ['/admin/requests', 'Requests'],
  ['/admin/embassy', 'Embassy'],
  ['/admin/personas', 'Personas'],
  ['/admin/registry', 'Registry'],
  ['/admin/settings', 'Settings'],
  ['/admin/audit', 'Audit'],
];

function Route({ path, onSettingsChanged }: { path: string; onSettingsChanged: () => void }) {
  let m: RegExpExecArray | null;
  if (path === '/admin/' || path === '/admin') return <Overview />;
  if (path === '/admin/inbox') return <Inbox />;
  if ((m = /^\/admin\/conversations\/([A-Za-z0-9_-]+)$/.exec(path))) return <Conversation key={m[1]} id={m[1]!} />;
  if (path === '/admin/requests') return <Requests />;
  if ((m = /^\/admin\/requests\/([A-Za-z0-9_-]+)$/.exec(path))) return <RequestDetail key={m[1]} id={m[1]!} />;
  if (path === '/admin/settings') return <Settings onChanged={onSettingsChanged} />;
  if (path === '/admin/audit') return <Audit />;
  if (path === '/admin/embassy') return <Embassy />;
  if ((m = /^\/admin\/embassy\/([A-Za-z0-9_-]+)$/.exec(path))) return <EmbassyDetailPage key={m[1]} id={m[1]!} />;
  if (path === '/admin/personas') return <Personas />;
  if ((m = /^\/admin\/personas\/([A-Za-z0-9_-]+)$/.exec(path))) return <PersonaDetailPage key={m[1]} id={m[1]!} />;
  if (path === '/admin/registry') return <RegistryPage />;
  return <p>Page not found.</p>;
}

function App() {
  const path = usePath();
  const session = useLoad(() => api.get<Session>('/session'), []);
  const active = (href: string) => (href === '/admin/' ? path === '/admin/' || path === '/admin' : path.startsWith(href));
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="top">
        <span className="brand">MyHumanRep · Admin</span>
        <nav aria-label="Admin">
          {NAV.map(([href, text]) => (
            <Link key={href} to={href} className={active(href) ? 'current' : undefined}>
              {text}
            </Link>
          ))}
        </nav>
        {session.data && (
          <span className="who">
            {session.data.email} · {session.data.environment}
          </span>
        )}
      </header>
      {session.data && !session.data.intake_enabled && (
        <div className="banner" role="status">
          Public intake is paused. New agent inquiries are rejected with 503; existing conversations still work.{' '}
          <Link to="/admin/settings">Change in Settings</Link>
        </div>
      )}
      <main id="main">
        <ErrorBox error={session.error} />
        <Route path={path} onSettingsChanged={session.reload} />
      </main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
