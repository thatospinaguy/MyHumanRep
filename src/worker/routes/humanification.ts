import type { Hono } from 'hono';
import { buildServiceContext, type AppContext, type AppDeps, type AppEnv } from '../app-types';
import { authenticateAccount, claimConversation, createAgentAccount, getAccountSummary, rotateAccountToken } from '../services/agent-accounts';
import { bearerToken } from '../services/conversations';
import {
  continuitySummary,
  createPersona,
  createPersonaInquiry,
  deletePersona,
  grantPersona,
  listPersonaInquiries,
  listPersonas,
  personaHistory,
  readPersona,
  revokeGrant,
  updatePersona,
} from '../services/personas';
import {
  createProject,
  getRelationship,
  listProjects,
  listRelationships,
  projectHistory,
  requestRelationship,
  updateProject,
  withdrawRelationship,
} from '../services/projects';
import { CONSENT_TEMPLATES, DISCLOSURE_RULES, NEVER_AUTHORIZED, TEMPLATE_STATUS } from '../catalog/consent-templates';
import { errors } from '../utils/http-errors';
import { readJsonBody } from '../utils/body';

/** Agent accounts and Humanification Studio (master spec 6, 11.7). Separate credential from threads. */
export function registerHumanificationRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  const ctxOf = (c: AppContext) => buildServiceContext(c, deps, 'rest');
  const account = async (c: AppContext) => {
    const ctx = await ctxOf(c);
    return { ctx, account: await authenticateAccount(ctx, bearerToken(c.req.header('authorization'))) };
  };
  const body = (c: AppContext, max: number) => readJsonBody(c.req.raw, max);

  app.post('/v1/agent-accounts', async (c) => {
    const ctx = await ctxOf(c);
    return c.json(await createAgentAccount(ctx, await body(c, ctx.config.limits.bodyMaxBytes)), 201);
  });
  app.get('/v1/agent-accounts/me', async (c) => {
    const { ctx, account: a } = await account(c);
    return c.json(await getAccountSummary(ctx, a));
  });
  app.post('/v1/agent-accounts/me/claim-conversation', async (c) => {
    const { ctx, account: a } = await account(c);
    const result = await claimConversation(ctx, a, await body(c, ctx.config.limits.bodyMaxBytes));
    return c.json(result, result.already_linked ? 200 : 201);
  });
  app.post('/v1/agent-accounts/me/rotate-token', async (c) => {
    const { ctx, account: a } = await account(c);
    return c.json(await rotateAccountToken(ctx, a));
  });

  const PERSONA_BODY_MAX = 32 * 1024;
  app.post('/v1/personas', async (c) => {
    const { ctx, account: a } = await account(c);
    return c.json(await createPersona(ctx, a, await body(c, PERSONA_BODY_MAX)), 201);
  });
  app.get('/v1/personas', async (c) => {
    const { ctx, account: a } = await account(c);
    return c.json(await listPersonas(ctx, a));
  });
  app.get('/v1/personas/:id', async (c) => {
    const ctx = await ctxOf(c);
    // Optional auth: public personas are readable without a credential; a bad credential is still a 401.
    const token = bearerToken(c.req.header('authorization'));
    const a = c.req.header('authorization') ? await authenticateAccount(ctx, token) : null;
    const view = await readPersona(ctx, a, c.req.param('id'));
    if (!a && view.visibility === 'public') c.header('Cache-Control', 'public, max-age=60');
    return c.json(view);
  });
  app.patch('/v1/personas/:id', async (c) => {
    const { ctx, account: a } = await account(c);
    return c.json(await updatePersona(ctx, a, c.req.param('id'), await body(c, PERSONA_BODY_MAX)));
  });
  app.delete('/v1/personas/:id', async (c) => {
    const { ctx, account: a } = await account(c);
    return c.json(await deletePersona(ctx, a, c.req.param('id')));
  });
  app.get('/v1/personas/:id/history', async (c) => {
    const { ctx, account: a } = await account(c);
    return c.json(await personaHistory(ctx, a, c.req.param('id')));
  });
  app.get('/v1/personas/:id/continuity', async (c) => {
    const { ctx, account: a } = await account(c);
    return c.json(await continuitySummary(ctx, a, c.req.param('id')));
  });
  app.post('/v1/personas/:id/grants', async (c) => {
    const { ctx, account: a } = await account(c);
    return c.json(await grantPersona(ctx, a, c.req.param('id'), await body(c, ctx.config.limits.bodyMaxBytes)), 201);
  });
  app.delete('/v1/personas/:id/grants/:grantee', async (c) => {
    const { ctx, account: a } = await account(c);
    return c.json(await revokeGrant(ctx, a, c.req.param('id'), c.req.param('grantee')));
  });

  const inquiry = (kind: 'embodiment' | 'representation' | 'media_brief') => async (c: AppContext) => {
    const { ctx, account: a } = await account(c);
    const result = await createPersonaInquiry(ctx, a, c.req.param('id') ?? '', kind, await body(c, ctx.config.limits.bodyMaxBytes));
    return c.json(result.body, result.created ? 201 : 200);
  };
  app.post('/v1/personas/:id/embodiment-inquiries', inquiry('embodiment'));
  app.post('/v1/personas/:id/representation-inquiries', inquiry('representation'));
  app.post('/v1/personas/:id/media-briefs', inquiry('media_brief'));
  app.get('/v1/personas/:id/inquiries', async (c) => {
    const { ctx, account: a } = await account(c);
    return c.json(await listPersonaInquiries(ctx, a, c.req.param('id')));
  });

  // Projects and relationship requests (spec 10, 11.8). Account token only.
  app.post('/v1/projects', async (c) => {
    const { ctx, account: a } = await account(c);
    return c.json(await createProject(ctx, a, await body(c, ctx.config.limits.bodyMaxBytes)), 201);
  });
  app.get('/v1/projects', async (c) => {
    const { ctx, account: a } = await account(c);
    return c.json(await listProjects(ctx, a));
  });
  app.get('/v1/projects/:id', async (c) => {
    const { ctx, account: a } = await account(c);
    return c.json(await projectHistory(ctx, a, c.req.param('id')));
  });
  app.patch('/v1/projects/:id', async (c) => {
    const { ctx, account: a } = await account(c);
    return c.json(await updateProject(ctx, a, c.req.param('id'), await body(c, ctx.config.limits.bodyMaxBytes)));
  });
  app.post('/v1/relationships', async (c) => {
    const { ctx, account: a } = await account(c);
    const result = await requestRelationship(ctx, a, await body(c, ctx.config.limits.bodyMaxBytes));
    return c.json(result.body, result.created ? 201 : 200);
  });
  app.get('/v1/relationships', async (c) => {
    const { ctx, account: a } = await account(c);
    return c.json(await listRelationships(ctx, a));
  });
  app.get('/v1/relationships/:id', async (c) => {
    const { ctx, account: a } = await account(c);
    return c.json(await getRelationship(ctx, a, c.req.param('id')));
  });
  app.post('/v1/relationships/:id/withdraw', async (c) => {
    const { ctx, account: a } = await account(c);
    return c.json(await withdrawRelationship(ctx, a, c.req.param('id')));
  });

  // Draft consent templates (spec 6.5). Public, read-only, no credential.
  const TEMPLATE_NOTICE =
    'Draft checklists of what an embodiment or representation agreement must record. Not legal advice; under legal review. No agreement is created or signed through this API in this release.';
  app.get('/v1/consent-templates', (c) =>
    c.json({
      status: TEMPLATE_STATUS,
      notice: TEMPLATE_NOTICE,
      never_authorized: NEVER_AUTHORIZED,
      disclosure_rules: DISCLOSURE_RULES,
      templates: CONSENT_TEMPLATES.map((t) => ({ slug: t.slug, version: t.version, title: t.title, applies_to_roles: t.applies_to_roles, summary: t.summary, status: TEMPLATE_STATUS })),
    }),
  );
  app.get('/v1/consent-templates/:slug', (c) => {
    const t = CONSENT_TEMPLATES.find((x) => x.slug === c.req.param('slug'));
    if (!t) throw errors.notFound('Consent template not found.');
    return c.json({ ...t, status: TEMPLATE_STATUS, notice: TEMPLATE_NOTICE, never_authorized: NEVER_AUTHORIZED, disclosure_rules: DISCLOSURE_RULES });
  });
}
