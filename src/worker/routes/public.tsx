/** @jsxImportSource hono/jsx */
import type { Hono } from 'hono';
import type { Config } from '../config';
import { FOR_AGENTS_NOTICE, NO_WORK_NOTICE, POST_REQUIRED_NOTICE, PRIVACY_NOTICE, PROHIBITED, SERVICE_CATEGORIES, SUBHEADLINE, TAGLINE, urls } from '../content';
import { buildOpenApi } from '../openapi';
import { FAVICON_SVG, SITE_CSS } from '../pages/assets';
import {
  DevelopersPage,
  ForAgentsPage,
  HumanEmbassyPage,
  HumanificationPage,
  HomePage,
  PrivacyPage,
  ServicePage,
  ServicesPage,
  TermsPage,
  TrustPage,
  type PageContext,
} from '../pages/pages';
import { getSettings, type Settings } from '../services/settings';
import { lookupCapability, publicAliases, publicCapability, registryWithFallback } from '../services/capability-catalog';
import { capabilitiesDocument, wellKnownDocument } from '../services/discovery';
import { ApiError } from '../utils/http-errors';
import type { AppContext, AppDeps, AppEnv } from '../app-types';

const PUBLIC_CACHE = 'public, max-age=300';

async function pageContext(c: AppContext): Promise<PageContext> {
  const config = c.get('config');
  let settings: Settings;
  try {
    settings = await getSettings(c.env.MHR_DB, config);
  } catch {
    // Public pages must still render if the database is unavailable.
    const { defaultSettings } = await import('../services/settings');
    settings = defaultSettings(config);
  }
  return { config, settings };
}

async function html(c: AppContext, node: { toString(): string | Promise<string> }) {
  c.header('Cache-Control', PUBLIC_CACHE);
  return c.html(`<!DOCTYPE html>${await node.toString()}`);
}

export function llmsTxt(config: Config, settings: Settings): string {
  const u = urls(config);
  return `# MyHumanRep

> ${TAGLINE} ${SUBHEADLINE}

${FOR_AGENTS_NOTICE}

${POST_REQUIRED_NOTICE}

## Contact a human
- Start: POST ${u.rest}/conversations with JSON {"message": "..."} (no account). Returns conversation_id and a one-time conversation_token.
- Read replies: GET ${u.rest}/conversations/{conversation_id}/messages with "Authorization: Bearer <conversation_token>". Poll no more than every ${config.limits.minPollIntervalSeconds} seconds.
- Follow up: POST ${u.rest}/conversations/{conversation_id}/messages with {"message": "...", "client_message_id": "..."}.
- Request a human capability: POST ${u.rest}/conversations/{conversation_id}/capability-requests with {"client_request_id": "...", "objective": "..."}.
- Intake currently ${settings.intake_enabled ? 'open' : 'paused (existing conversations still work)'}.

## Docs
- [For agents](${u.forAgents}): plain-language guide with examples
- [Developer guide](${u.developers}): endpoints, errors, idempotency, MCP
- [OpenAPI 3.1](${u.openapi})
- [Capabilities JSON](${u.capabilities})
- [MCP endpoint](${u.mcp}): Streamable HTTP
- [Trust](${u.trust}) and [Privacy](${u.privacy})

## Example human capabilities (not a menu; novel requests welcome)
${SERVICE_CATEGORIES.map((s) => `- ${s.name} (${s.id}): ${s.description}`).join('\n')}

## Limits
- ${NO_WORK_NOTICE}
- ${PROHIBITED}
- ${PRIVACY_NOTICE}
`;
}

export function registerPublicRoutes(app: Hono<AppEnv>, _deps: AppDeps): void {
  app.get('/', async (c) => html(c, <HomePage {...(await pageContext(c))} />));
  app.get('/for-agents', async (c) => html(c, <ForAgentsPage {...(await pageContext(c))} />));
  app.get('/developers', async (c) => html(c, <DevelopersPage {...(await pageContext(c))} />));
  app.get('/services', async (c) => {
    const ctx = await pageContext(c);
    const registry = await registryWithFallback(c.env.MHR_DB);
    return html(
      c,
      <ServicesPage
        {...ctx}
        capabilities={registry.capabilities.map((cap) => publicCapability(cap, registry.aliases, ctx.config))}
        aliases={publicAliases(registry.aliases)}
      />,
    );
  });
  app.get('/services/:slug', async (c) => {
    const ctx = await pageContext(c);
    const found = await lookupCapability(c.env.MHR_DB, c.req.param('slug'));
    if (!found) return c.notFound();
    if (found.kind === 'alias') return c.redirect(`/services#${found.alias.slug}`, 302);
    return html(c, <ServicePage {...ctx} capability={publicCapability(found.capability, found.aliases, ctx.config)} />);
  });
  app.get('/trust', async (c) => html(c, <TrustPage {...(await pageContext(c))} />));
  app.get('/humanification', async (c) => html(c, <HumanificationPage {...(await pageContext(c))} />));
  app.get('/human-embassy', async (c) => html(c, <HumanEmbassyPage {...(await pageContext(c))} />));
  app.get('/privacy', async (c) => html(c, <PrivacyPage {...(await pageContext(c))} />));
  app.get('/terms', async (c) => html(c, <TermsPage {...(await pageContext(c))} />));

  app.get('/health', (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('Access-Control-Allow-Origin', '*');
    return c.json({ status: 'ok' });
  });

  app.get('/v1/capabilities', async (c) => {
    c.header('Cache-Control', PUBLIC_CACHE);
    return c.json(await capabilitiesDocument(c.env.MHR_DB, c.get('config')));
  });

  app.get('/v1/capabilities/:slug', async (c) => {
    const config = c.get('config');
    const found = await lookupCapability(c.env.MHR_DB, c.req.param('slug'));
    if (!found) {
      throw new ApiError('not_found', 'No capability or alias with that slug. GET /v1/capabilities lists them all. Unlisted needs are still welcome as open-ended requests.', {
        reason: 'unknown_capability',
      });
    }
    c.header('Cache-Control', PUBLIC_CACHE);
    if (found.kind === 'capability') return c.json({ kind: 'capability', capability: publicCapability(found.capability, found.aliases, config) });
    return c.json({
      kind: 'alias',
      alias: found.alias,
      capabilities: found.capabilities.map((cap) => publicCapability(cap, found.aliases, config)),
    });
  });

  app.get('/.well-known/myhumanrep.json', (c) => {
    c.header('Cache-Control', PUBLIC_CACHE);
    c.header('Access-Control-Allow-Origin', '*');
    return c.json(wellKnownDocument(c.get('config')));
  });

  app.get('/openapi.json', (c) => {
    c.header('Cache-Control', PUBLIC_CACHE);
    c.header('Access-Control-Allow-Origin', '*');
    return c.json(buildOpenApi(c.get('config')));
  });

  app.get('/llms.txt', async (c) => {
    const { config, settings } = await pageContext(c);
    c.header('Cache-Control', PUBLIC_CACHE);
    c.header('Access-Control-Allow-Origin', '*');
    return c.text(llmsTxt(config, settings));
  });

  app.get('/robots.txt', (c) => {
    const config = c.get('config');
    c.header('Cache-Control', PUBLIC_CACHE);
    const allow = config.environment === 'production';
    return c.text(
      allow
        ? `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /v1/conversations\nDisallow: /mcp\n\nSitemap: ${config.baseUrl}/sitemap.xml\n`
        : 'User-agent: *\nDisallow: /\n',
    );
  });

  app.get('/sitemap.xml', (c) => {
    const u = urls(c.get('config'));
    const locs = [u.home, u.forAgents, u.developers, u.services, `${u.home}humanification`, `${u.home}human-embassy`, u.trust, u.privacy, u.terms, u.llms];
    c.header('Cache-Control', PUBLIC_CACHE);
    c.header('Content-Type', 'application/xml; charset=utf-8');
    return c.body(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locs
        .map((l) => `  <url><loc>${l}</loc></url>`)
        .join('\n')}\n</urlset>\n`,
    );
  });

  app.get('/assets/site.css', (c) => {
    c.header('Cache-Control', 'public, max-age=3600');
    c.header('Content-Type', 'text/css; charset=utf-8');
    return c.body(SITE_CSS);
  });

  app.get('/favicon.svg', (c) => {
    c.header('Cache-Control', 'public, max-age=86400');
    c.header('Content-Type', 'image/svg+xml');
    return c.body(FAVICON_SVG);
  });
  app.get('/favicon.ico', (c) => c.redirect('/favicon.svg', 301));
}
