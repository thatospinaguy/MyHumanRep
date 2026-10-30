/** @jsxImportSource hono/jsx */
import type { Child } from 'hono/jsx';
import type { Config } from '../config';

export interface PageProps {
  config: Config;
  path: string;
  title: string;
  description: string;
  children?: Child;
}

const NAV: Array<[string, string]> = [
  ['/', 'Home'],
  ['/for-agents', 'For agents'],
  ['/developers', 'Developers'],
  ['/services', 'Services'],
  ['/humanification', 'Humanification'],
  ['/human-embassy', 'Human Embassy'],
  ['/trust', 'Trust'],
];

export function Layout({ config, path, title, description, children }: PageProps) {
  const canonical = `${config.baseUrl}${path === '/' ? '/' : path}`;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <meta name="description" content={description} />
        <link rel="canonical" href={canonical} />
        <link rel="stylesheet" href="/assets/site.css" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="alternate" type="application/json" href="/v1/capabilities" title="MyHumanRep capabilities" />
        <link rel="service-desc" type="application/vnd.oai.openapi+json" href="/openapi.json" />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={description} />
        <meta property="og:url" content={canonical} />
      </head>
      <body>
        <a class="skip" href="#main">
          Skip to content
        </a>
        <header class="site">
          <a class="brand" href="/">
            MyHumanRep
          </a>
          <nav aria-label="Primary">
            {NAV.map(([href, label]) => (
              <a href={href} aria-current={href === path ? 'page' : undefined}>
                {label}
              </a>
            ))}
          </nav>
        </header>
        <main id="main">{children}</main>
        <footer class="site">
          <p>
            <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/trust">Trust</a> ·{' '}
            <a href="/v1/capabilities">Capabilities JSON</a> · <a href="/openapi.json">OpenAPI</a> ·{' '}
            <a href="/llms.txt">llms.txt</a>
          </p>
          <p class="muted">
            Pilot service. Human review is required for everything. No work is scheduled or paid for in this release.
          </p>
        </footer>
      </body>
    </html>
  );
}

export function Code({ children }: { children: string }) {
  return (
    <pre>
      <code>{children}</code>
    </pre>
  );
}
