import type { Hono } from 'hono';
import { waitUntilOf, type AppContext, type AppDeps, type AppEnv } from '../app-types';
import { assertSameOriginWrite, authenticateAdmin } from '../middleware/admin-auth';
import {
  clarifyRequest,
  deleteConversation,
  exportConversation,
  getConversationDetail,
  getRequestDetail,
  listAudit,
  listConversations,
  listRequests,
  patchConversation,
  patchRequest,
  replyToConversation,
  toCsv,
  type AdminContext,
} from '../services/admin';
import { auditStatement } from '../services/audit';
import { parseInput } from '../services/context';
import { getMetrics, metricsToCsvRows } from '../services/metrics';
import { getSettings, SettingsPatchSchema, settingsUpsertStatements } from '../services/settings';
import { MetricsQuery } from '../schemas/admin';
import {
  acceptProposalAdmin,
  counterProposalAdmin,
  createProposalAdmin,
  decideProposalAdmin,
  getProposalAdmin,
  listProposalsAdmin,
  listRequestProposalsAdmin,
} from '../services/admin-proposals';
import { getEmbassyInquiry, listEmbassy, patchEmbassyInquiry, patchSelfReport, researchSummary } from '../services/admin-embassy';
import {
  deletePersonaAdmin,
  getPersonaAdmin,
  listPersonaInquiriesAdmin,
  listPersonasAdmin,
  patchPersonaInquiry,
} from '../services/admin-humanification';
import { decideCandidate, listCandidates, listRegistryAdmin, patchCapability } from '../services/admin-registry';
import { FeatureFlagsPatch, flagsUpsertStatement, getFeatureFlags, moduleReadiness, type FeatureFlags } from '../services/feature-flags';
import { readJsonBody } from '../utils/body';
import { ApiError, errors } from '../utils/http-errors';

const ADMIN_BODY_MAX = 32 * 1024;

function adminCtx(c: AppContext): AdminContext {
  return {
    db: c.env.MHR_DB,
    config: c.get('config'),
    now: c.get('now'),
    actor: c.get('admin').email,
    requestId: c.get('requestId'),
  };
}

async function body(c: AppContext): Promise<unknown> {
  return readJsonBody(c.req.raw, ADMIN_BODY_MAX);
}

function download(c: AppContext, content: string, filename: string, type: string): Response {
  c.header('Content-Type', type);
  c.header('Content-Disposition', `attachment; filename="${filename}"`);
  c.header('Cache-Control', 'no-store');
  return c.body(content);
}

export function registerAdminRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  // Authentication and CSRF checks run before every admin route, API and UI alike.
  app.use('/admin', async (c, next) => {
    c.set('admin', await authenticateAdmin(c.req.raw, c.get('config'), deps.accessKeyResolver));
    await next();
  });
  app.use('/admin/*', async (c, next) => {
    c.set('admin', await authenticateAdmin(c.req.raw, c.get('config'), deps.accessKeyResolver));
    if (c.req.path.startsWith('/admin/api/')) assertSameOriginWrite(c.req.raw, c.get('config'));
    await next();
  });

  app.get('/admin/api/session', async (c) => {
    const settings = await getSettings(c.env.MHR_DB, c.get('config'));
    const admin = c.get('admin');
    return c.json({
      email: admin.email,
      auth_mode: admin.mode,
      environment: c.get('config').environment,
      intake_enabled: settings.intake_enabled,
      notify_provider: c.get('config').notifyProvider,
    });
  });

  app.get('/admin/api/conversations', async (c) => c.json(await listConversations(adminCtx(c), c.req.query(), false)));
  app.post('/admin/api/conversations/search', async (c) => c.json(await listConversations(adminCtx(c), await body(c), true)));
  app.get('/admin/api/conversations/:id', async (c) => c.json(await getConversationDetail(adminCtx(c), c.req.param('id'))));
  app.post('/admin/api/conversations/:id/reply', async (c) =>
    c.json(await replyToConversation(adminCtx(c), c.req.param('id'), await body(c)), 201),
  );
  app.patch('/admin/api/conversations/:id', async (c) => c.json(await patchConversation(adminCtx(c), c.req.param('id'), await body(c))));
  app.post('/admin/api/conversations/:id/export', async (c) => {
    const id = c.req.param('id');
    const data = await exportConversation(adminCtx(c), id);
    return download(c, JSON.stringify(data, null, 2), `${id}.json`, 'application/json; charset=utf-8');
  });
  app.delete('/admin/api/conversations/:id', async (c) => c.json(await deleteConversation(adminCtx(c), c.req.param('id'), await body(c))));

  app.get('/admin/api/capability-requests', async (c) => c.json(await listRequests(adminCtx(c), c.req.query())));
  app.get('/admin/api/capability-requests/:id', async (c) => c.json(await getRequestDetail(adminCtx(c), c.req.param('id'))));
  app.patch('/admin/api/capability-requests/:id', async (c) => c.json(await patchRequest(adminCtx(c), c.req.param('id'), await body(c))));
  app.post('/admin/api/capability-requests/:id/clarify', async (c) =>
    c.json(await clarifyRequest(adminCtx(c), c.req.param('id'), await body(c)), 201),
  );

  app.get('/admin/api/metrics', async (c) => {
    const { format } = parseInput(MetricsQuery, c.req.query());
    const metrics = await getMetrics(adminCtx(c));
    if (format === 'csv') {
      return download(c, toCsv(metricsToCsvRows(metrics), ['evidence', 'metric', 'value']), 'myhumanrep-metrics.csv', 'text/csv; charset=utf-8');
    }
    return c.json(metrics);
  });

  app.get('/admin/api/audit', async (c) => {
    const result = await listAudit(adminCtx(c), c.req.query());
    if (result.format === 'csv') {
      const ctx = adminCtx(c);
      waitUntilOf(c)(auditStatement(ctx.db, ctx.actor, 'audit.export', 'system', null, { rows: result.items.length }, ctx.now).run());
      return download(
        c,
        toCsv(result.items, ['created_at', 'admin_subject', 'action', 'target_type', 'target_id', 'metadata']),
        'myhumanrep-audit.csv',
        'text/csv; charset=utf-8',
      );
    }
    return c.json({ items: result.items, next_cursor: result.next_cursor });
  });

  app.get('/admin/api/settings', async (c) => {
    const config = c.get('config');
    return c.json({
      settings: await getSettings(c.env.MHR_DB, config),
      feature_flags: moduleReadiness(await getFeatureFlags(c.env.MHR_DB)),
      read_only: {
        environment: config.environment,
        public_base_url: config.baseUrl,
        notify_provider: config.notifyProvider,
        notify_to_configured: config.notifyTo !== '',
        admin_auth_mode: config.adminAuthMode,
        limits: config.limits,
      },
    });
  });
  app.patch('/admin/api/settings', async (c) => {
    const ctx = adminCtx(c);
    const raw = await body(c);
    const { feature_flags: rawFlags, ...rest } = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const patch = parseInput(SettingsPatchSchema, rest);
    const flagPatch = rawFlags === undefined ? {} : parseInput(FeatureFlagsPatch, rawFlags);
    const keys = Object.keys(patch);
    const flagKeys = Object.keys(flagPatch);
    if (keys.length === 0 && flagKeys.length === 0) {
      throw new ApiError('invalid_request', 'Provide at least one setting.', { reason: 'empty_patch' });
    }
    const statements = settingsUpsertStatements(ctx.db, patch, ctx.actor, ctx.now);
    if (flagKeys.length > 0) {
      const flags = { ...(await getFeatureFlags(ctx.db)), ...flagPatch } as FeatureFlags;
      statements.push(flagsUpsertStatement(ctx.db, flags, ctx.actor, ctx.now));
    }
    await ctx.db.batch([
      ...statements,
      auditStatement(
        ctx.db,
        ctx.actor,
        'settings.update',
        'settings',
        null,
        {
          changed: [...keys, ...flagKeys.map((k) => `feature_flags.${k}`)],
          ...(patch.intake_enabled !== undefined ? { intake_enabled: patch.intake_enabled } : {}),
          ...(patch.notifications_enabled !== undefined ? { notifications_enabled: patch.notifications_enabled } : {}),
        },
        ctx.now,
      ),
    ]);
    return c.json({
      settings: await getSettings(ctx.db, ctx.config),
      feature_flags: moduleReadiness(await getFeatureFlags(ctx.db)),
    });
  });

  // Capability registry (master spec Phase 1).
  app.get('/admin/api/capabilities', async (c) => c.json(await listRegistryAdmin(adminCtx(c))));
  app.patch('/admin/api/capabilities/:slug', async (c) =>
    c.json({ capability: await patchCapability(adminCtx(c), c.req.param('slug'), await body(c)) }),
  );
  app.get('/admin/api/candidate-capabilities', async (c) => c.json(await listCandidates(adminCtx(c), c.req.query('status'))));
  app.post('/admin/api/candidate-capabilities/:id/decision', async (c) =>
    c.json(await decideCandidate(adminCtx(c), c.req.param('id'), await body(c))),
  );

  // Humanification (master spec Phase 2). The owner reviews; persona content stays agent-owned.
  app.get('/admin/api/personas', async (c) => c.json(await listPersonasAdmin(adminCtx(c), c.req.query('visibility'))));
  app.get('/admin/api/personas/:id', async (c) => c.json(await getPersonaAdmin(adminCtx(c), c.req.param('id'))));
  app.delete('/admin/api/personas/:id', async (c) => c.json(await deletePersonaAdmin(adminCtx(c), c.req.param('id'), await body(c))));
  app.get('/admin/api/persona-inquiries', async (c) => c.json(await listPersonaInquiriesAdmin(adminCtx(c), c.req.query('status'))));
  app.patch('/admin/api/persona-inquiries/:id', async (c) => c.json({ inquiry: await patchPersonaInquiry(adminCtx(c), c.req.param('id'), await body(c)) }));

  // Human Embassy (master spec Phase 3): separate from commercial requests.
  app.get('/admin/api/embassy', async (c) => c.json(await listEmbassy(adminCtx(c), c.req.query('status'))));
  app.get('/admin/api/embassy/:id', async (c) => c.json(await getEmbassyInquiry(adminCtx(c), c.req.param('id'))));
  app.patch('/admin/api/embassy/:id', async (c) => c.json({ inquiry: await patchEmbassyInquiry(adminCtx(c), c.req.param('id'), await body(c)) }));
  app.patch('/admin/api/self-reports/:id', async (c) => c.json(await patchSelfReport(adminCtx(c), c.req.param('id'), await body(c))));
  app.get('/admin/api/research/summary', async (c) => c.json(await researchSummary(adminCtx(c))));

  // Later-phase admin modules: typed, never fake success.
  app.all('/admin/api/representatives', () => {
    throw errors.notYetAvailable('Human representative network (Phase 5)');
  });
  app.all('/admin/api/representatives/:id', () => {
    throw errors.notYetAvailable('Human representative network (Phase 5)');
  });
  app.get('/admin/api/proposals', async (c) => c.json(await listProposalsAdmin(adminCtx(c), c.req.query('status'))));
  app.get('/admin/api/proposals/:id', async (c) => c.json(await getProposalAdmin(adminCtx(c), c.req.param('id'))));
  app.post('/admin/api/proposals/:id/counteroffers', async (c) => c.json(await counterProposalAdmin(adminCtx(c), c.req.param('id'), await body(c)), 201));
  app.post('/admin/api/proposals/:id/accept', async (c) => c.json(await acceptProposalAdmin(adminCtx(c), c.req.param('id'), await body(c))));
  app.post('/admin/api/proposals/:id/decision', async (c) => c.json(await decideProposalAdmin(adminCtx(c), c.req.param('id'), await body(c))));
  app.get('/admin/api/capability-requests/:id/proposals', async (c) => c.json(await listRequestProposalsAdmin(adminCtx(c), c.req.param('id'))));
  app.post('/admin/api/capability-requests/:id/proposals', async (c) => c.json(await createProposalAdmin(adminCtx(c), c.req.param('id'), await body(c)), 201));

  app.all('/admin/api/*', () => {
    throw new ApiError('not_found', 'Unknown admin endpoint.');
  });

  // Admin SPA: served from the built assets only after authentication succeeded above.
  const serveSpa = async (c: AppContext) => {
    const assets = c.env.ASSETS;
    if (!assets) return c.text('Admin UI not built. Run npm run build.', 503);
    const url = new URL(c.req.url);
    const isAsset = /^\/admin\/assets\/[A-Za-z0-9._-]+$/.test(url.pathname);
    const target = new URL(isAsset ? url.pathname : '/admin/index.html', url.origin);
    const res = await assets.fetch(new Request(target.toString(), { method: 'GET' }));
    if (!res.ok && isAsset) return c.text('Not found', 404);
    const headers = new Headers(res.headers);
    headers.set('Cache-Control', 'no-store');
    return new Response(res.body, { status: res.status, headers });
  };
  app.get('/admin', (c) => c.redirect('/admin/', 302));
  app.get('/admin/*', serveSpa);
}
