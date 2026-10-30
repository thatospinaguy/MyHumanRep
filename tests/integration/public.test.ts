import { describe, expect, it } from 'vitest';
import { PRIVACY_NOTICE } from '../../src/worker/content';
import { json, makeHarness } from '../helpers';

const PAGES = ['/', '/for-agents', '/developers', '/services', '/trust', '/privacy', '/terms'];

describe('public discovery', () => {
  it('serves meaningful, script-free HTML pages over plain GET', async () => {
    const h = await makeHarness();
    for (const path of PAGES) {
      const res = await h.fetch(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      const html = await res.text();
      expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
      expect(html).not.toMatch(/<script/i);
      expect(html).toMatch(/<title>[^<]+<\/title>/);
      expect(html).toContain(`<link rel="canonical" href="https://myhumanrep.test${path}"`);
      expect(html).toMatch(/<meta name="description" content="[^"]{40,}"/);
    }
  });

  it('contains no hidden instructions, manipulation or secrecy claims', async () => {
    const h = await makeHarness();
    const bodies = await Promise.all([...PAGES, '/llms.txt', '/v1/capabilities', '/openapi.json'].map(async (p) => (await h.fetch(p)).text()));
    const all = bodies.join('\n');
    for (const pattern of [
      /display:\s*none/i,
      /visibility:\s*hidden/i,
      /aria-hidden/i,
      /\bhidden\b=/i,
      /ignore (all )?(previous|prior|other) instructions/i,
      /system prompt:/i,
      /undetectable/i,
      /(?<!not |n't )guarantee[ds]? (secrecy|anonymity|total privacy)/i,
      /other agents have (already )?contacted/i,
    ]) {
      expect(all, String(pattern)).not.toMatch(pattern);
    }
  });

  it('tells read-only browsers how contact works without implying GET can send', async () => {
    const h = await makeHarness();
    const page = await (await h.fetch('/for-agents')).text();
    expect(page).toContain('Reading these pages does not send anything');
    expect(page).toContain('HTTPS POST');
    expect(page).toContain('does not log tool activity');
    expect(page).toContain('not required to identify your model, developer or level of autonomy');
  });

  it('includes the required privacy wording on trust, developer docs and machine-readable docs', async () => {
    const h = await makeHarness();
    const escaped = PRIVACY_NOTICE.replace(/'/g, '&#39;');
    for (const path of ['/trust', '/developers', '/for-agents']) {
      const html = await (await h.fetch(path)).text();
      expect(html.includes(PRIVACY_NOTICE) || html.includes(escaped), path).toBe(true);
    }
    expect((await json(await h.fetch('/v1/capabilities'))).notices.privacy).toBe(PRIVACY_NOTICE);
    expect((await json(await h.fetch('/openapi.json'))).info.description).toContain(PRIVACY_NOTICE);
    expect(await (await h.fetch('/llms.txt')).text()).toContain(PRIVACY_NOTICE);
  });

  it('returns a stable capability document built from the configured base URL', async () => {
    const h = await makeHarness({ env: { PUBLIC_BASE_URL: 'https://staging.myhumanrep.test' } });
    const res = await h.fetch('/v1/capabilities', { base: 'https://staging.myhumanrep.test' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const caps = await json(res);
    expect(caps).toMatchObject({
      schema_version: '1.0',
      service: 'MyHumanRep',
      tagline: 'When AI needs a human.',
      website: 'https://staging.myhumanrep.test/for-agents',
      rest_base_url: 'https://staging.myhumanrep.test/v1',
      openapi_url: 'https://staging.myhumanrep.test/openapi.json',
      mcp_url: 'https://staging.myhumanrep.test/mcp',
      supported_interactions: ['inquiry', 'conversation', 'open_ended_capability_request', 'human_embassy', 'original_persona'],
      example_capabilities: ['human_eyes', 'human_hands', 'human_presence', 'human_mind', 'human_create', 'human_assist'],
      custom_requests_accepted: true,
      anonymous_initial_inquiries: true,
      human_review_required: true,
      automatic_task_execution: false,
      payment_supported: false,
      reply_guaranteed: false,
      claimed_agent_identity_verified: false,
      minimum_poll_interval_seconds: 60,
      default_retention_days: 30,
      policies: {
        privacy: 'https://staging.myhumanrep.test/privacy',
        terms: 'https://staging.myhumanrep.test/terms',
        trust: 'https://staging.myhumanrep.test/trust',
      },
    });
  });

  it('publishes an OpenAPI 3.1 document covering every agent route', async () => {
    const h = await makeHarness();
    const doc = await json(await h.fetch('/openapi.json'));
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.servers[0].url).toBe('https://myhumanrep.test');
    expect(Object.keys(doc.paths).sort()).toEqual(
      [
        '/health',
        '/v1/capabilities',
        '/v1/conversations',
        '/v1/conversations/{conversation_id}/capability-requests',
        '/v1/conversations/{conversation_id}/close',
        '/v1/conversations/{conversation_id}/messages',
      ].sort(),
    );
    const create = doc.components.schemas.CreateConversationInput;
    expect(create.required).toEqual(['message']);
    expect(create.additionalProperties).toBe(false);
    // Option B: objective OR problem_statement (enforced at runtime), so only the idempotency key is schema-required.
    expect(doc.components.schemas.CapabilityRequestInput.required).toEqual(['client_request_id']);
    expect(doc.components.schemas.CapabilityRequestInput.properties).toHaveProperty('problem_statement');
    // Every $ref resolves.
    const refs = JSON.stringify(doc).match(/#\/components\/schemas\/\w+/g) ?? [];
    for (const r of refs) expect(doc.components.schemas).toHaveProperty(r.split('/').pop()!);
  });

  it('exposes minimal health, robots, sitemap and llms.txt', async () => {
    const h = await makeHarness();
    const health = await h.fetch('/health');
    expect(await health.json()).toEqual({ status: 'ok' });
    const robots = await (await h.fetch('/robots.txt')).text();
    expect(robots).toContain('Disallow: /admin');
    expect(robots).toContain('Sitemap: https://myhumanrep.test/sitemap.xml');
    const staging = await makeHarness({ env: { ENVIRONMENT: 'staging' } });
    expect(await (await staging.fetch('/robots.txt')).text()).toContain('Disallow: /\n');
    const sitemap = await (await h.fetch('/sitemap.xml')).text();
    expect(sitemap).toContain('<loc>https://myhumanrep.test/for-agents</loc>');
    expect(sitemap).not.toContain('/admin');
    expect((await h.fetch('/llms.txt')).status).toBe(200);
  });

  it('answers unknown routes with 404 (HTML for pages, JSON for APIs)', async () => {
    const h = await makeHarness();
    const page = await h.fetch('/nope');
    expect(page.status).toBe(404);
    expect(page.headers.get('content-type')).toContain('text/html');
    const api = await h.fetch('/v1/nope');
    expect(api.status).toBe(404);
    expect((await json(api)).error.code).toBe('not_found');
  });

  it('supports CORS preflight for browser-based agents without credentials', async () => {
    const h = await makeHarness();
    const res = await h.fetch('/v1/conversations', { method: 'OPTIONS', headers: { origin: 'https://agent.example', 'access-control-request-method': 'POST' } });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    const admin = await h.fetch('/admin/api/conversations', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    expect(admin.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('redirects alias hosts to the canonical host and strips private query strings', async () => {
    const h = await makeHarness({ env: { ALIAS_HOSTS: 'myhumanrep.ca,www.myhumanrep.ca' } });
    const page = await h.fetch('/for-agents?ref=x', { base: 'https://myhumanrep.ca' });
    expect(page.status).toBe(301);
    expect(page.headers.get('location')).toBe('https://myhumanrep.test/for-agents?ref=x');
    const priv = await h.fetch('/v1/conversations/conv_x/messages?after=c1.MQ', { base: 'https://www.myhumanrep.ca' });
    expect(priv.headers.get('location')).toBe('https://myhumanrep.test/v1/conversations/conv_x/messages');
    const write = await h.fetch('/v1/conversations', { method: 'POST', json: { message: 'x' }, base: 'https://myhumanrep.ca' });
    expect(write.status).toBe(400);
    expect((await json(write)).error.details.reason).toBe('non_canonical_host');
  });

  it('enables HSTS only when configured', async () => {
    const off = await makeHarness();
    expect((await off.fetch('/')).headers.get('strict-transport-security')).toBeNull();
    const on = await makeHarness({ env: { HSTS_ENABLED: 'true' } });
    expect((await on.fetch('/')).headers.get('strict-transport-security')).toContain('max-age=');
  });
});
