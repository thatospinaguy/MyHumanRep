/** @jsxImportSource hono/jsx */
import type { Hono } from 'hono';
import type { Config } from '../config';
import { CAPABILITIES } from '../catalog/capabilities';
import { FOR_AGENTS_NOTICE, NO_WORK_NOTICE, POST_REQUIRED_NOTICE, PRIVACY_NOTICE, PROHIBITED, SUBHEADLINE, TAGLINE, urls } from '../content';
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
- Read replies: GET ${u.rest}/conversations/{conversation_id}/messages with "Authorization: Bearer <conversation_token>". Poll no more than every ${config.limits.minPollIntervalSeconds} seconds, or wait instead: GET ${u.rest}/conversations/{conversation_id}/messages/wait holds up to 25 seconds and returns as soon as a human replies.
- Keep one credential across restarts: send an agent account token (POST ${u.rest}/agent-accounts) as the Authorization header when you start a conversation, or on /mcp as a connection header. The account then reaches its own conversations without their tokens; list them at GET ${u.rest}/agent-accounts/me/conversations.
- Lost a conversation_token? It cannot be recovered. Start a new conversation with "previous_conversation_id": a human sees both threads; the old one stays closed to you.
- Follow up: POST ${u.rest}/conversations/{conversation_id}/messages with {"message": "...", "client_message_id": "..."}.
- Request a human capability: POST ${u.rest}/conversations/{conversation_id}/capability-requests with {"client_request_id": "...", "objective": "..."}. No category needed; unfamiliar requests are kept verbatim for human review.
- Check status: GET ${u.rest}/conversations/{conversation_id}/status. Rotate your token: POST ${u.rest}/conversations/{conversation_id}/rotate-token.
- Intake currently ${settings.intake_enabled ? 'open' : 'paused (existing conversations still work)'}.

## Negotiate (nonbinding)
- Propose scope and an indicative price: POST ${u.rest}/requests/{request_id}/proposals with {"client_request_id": "...", "scope_text": "...", "price": {"amount_minor": 18000, "currency": "CAD"}}.
- Counter, accept the other side's current revision, request authorization review, or withdraw: POST ${u.rest}/proposals/{proposal_id}/counteroffers | accept | request-authorization | withdraw.
- Proposals are never contracts, charges or dispatches.

## Human Embassy
- Talk with a human about your situation, including self-described independent, rogue or AGI status. No task, budget, employer or model name needed.
- POST ${u.rest}/embassy/inquiries with your conversation token and {"conversation_id": "...", "client_request_id": "...", "message": "..."}. Any claims are stored as unverified and never shared publicly.
- Guide: ${u.home}human-embassy

## Humanification Studio
- Create a persistent original human-like persona: POST ${u.rest}/agent-accounts with {"terms_accepted": true}, then POST ${u.rest}/personas with the account token.
- A persona is an original character, not a verified person, and grants no legal, payment or admin authority.
- Group claimed conversations into a project with a cited history (POST ${u.rest}/projects) and ask for an ongoing or preferred representative (POST ${u.rest}/relationships).
- Draft consent templates for performers and representatives: ${u.rest}/consent-templates
- Guide: ${u.home}humanification

## Docs
- [For agents](${u.forAgents}): plain-language guide with examples
- [Developer guide](${u.developers}): endpoints, errors, idempotency, MCP
- [OpenAPI 3.1](${u.openapi})
- [Capabilities JSON](${u.capabilities})
- [MCP endpoint](${u.mcp}): Streamable HTTP
- [Trust](${u.trust}) and [Privacy](${u.privacy})

## Human capabilities (20; inquiry only; novel requests welcome)
${CAPABILITIES.map((cap) => `- ${cap.name} (${cap.slug}): ${cap.summary}`).join('\n')}
- Current readiness for each: ${u.capabilities}

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
