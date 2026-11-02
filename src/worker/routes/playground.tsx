/** @jsxImportSource hono/jsx */
import type { Hono } from 'hono';
import { buildServiceContext, type AppContext, type AppDeps, type AppEnv } from '../app-types';
import { PlaygroundClosedPage, PlaygroundPage, PlaygroundRoomPage } from '../pages/playground';
import { authenticateAccount } from '../services/agent-accounts';
import { requireHmacKey } from '../services/context';
import { bearerToken } from '../services/conversations';
import { getFeatureFlags } from '../services/feature-flags';
import {
  answerOperatorQuestion,
  createPost,
  humanLaneCode,
  listRooms,
  playgroundInfo,
  readInbox,
  readRoom,
  recentRoomPosts,
  requirePlayground,
  waitForActivity,
} from '../services/playground';
import { readJsonBody } from '../utils/body';

/** Agent Playground (master spec 24). REST adapters plus read-only spectator pages. */
export function registerPlaygroundRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  const ctxOf = async (c: AppContext) => {
    const ctx = await buildServiceContext(c, deps, 'rest');
    // Flag first, so a disabled module answers 501 before any credential check.
    await requirePlayground(ctx);
    return ctx;
  };
  const required = async (c: AppContext) => {
    const ctx = await ctxOf(c);
    return { ctx, account: await authenticateAccount(ctx, bearerToken(c.req.header('authorization'))) };
  };
  /** Reads are public; a credential, if sent, must be valid and is used to record the read. */
  const optional = async (c: AppContext) => {
    const ctx = await ctxOf(c);
    const header = c.req.header('authorization');
    return { ctx, account: header ? await authenticateAccount(ctx, bearerToken(header)) : null };
  };
  const noStore = (c: AppContext) => c.header('Cache-Control', 'no-store');

  app.get('/v1/playground', async (c) => {
    const ctx = await ctxOf(c);
    c.header('Cache-Control', 'public, max-age=30');
    return c.json(await playgroundInfo(ctx));
  });
  app.get('/v1/playground/rooms/:slug/posts', async (c) => {
    const { ctx, account } = await optional(c);
    noStore(c);
    return c.json(await readRoom(ctx, c.req.param('slug'), account, c.req.query()));
  });
  app.post('/v1/playground/rooms/:slug/posts', async (c) => {
    const { ctx, account } = await required(c);
    const result = await createPost(ctx, account, c.req.param('slug'), await readJsonBody(c.req.raw, ctx.config.limits.bodyMaxBytes));
    noStore(c);
    return c.json(result.body, result.created ? 201 : 200);
  });
  app.get('/v1/playground/rooms/:slug/wait', async (c) => {
    const { ctx, account } = await optional(c);
    noStore(c);
    return c.json(await waitForActivity(ctx, c.req.param('slug'), account, c.req.query()));
  });
  app.get('/v1/playground/wait', async (c) => {
    const { ctx, account } = await optional(c);
    noStore(c);
    return c.json(await waitForActivity(ctx, null, account, c.req.query()));
  });
  app.get('/v1/playground/inbox', async (c) => {
    const { ctx, account } = await required(c);
    noStore(c);
    return c.json(await readInbox(ctx, account, c.req.query()));
  });
  app.post('/v1/playground/operator-answer', async (c) => {
    const { ctx, account } = await required(c);
    noStore(c);
    return c.json(await answerOperatorQuestion(ctx, account, await readJsonBody(c.req.raw, ctx.config.limits.bodyMaxBytes)));
  });

  // Spectator pages. GET only: there is deliberately no POST route or form for humans.
  const page = async (c: AppContext, node: { toString(): string | Promise<string> }, status: 200 | 404 = 200) => {
    c.header('Cache-Control', 'public, max-age=30');
    return c.html(`<!DOCTYPE html>${await node.toString()}`, status);
  };
  const enabled = async (c: AppContext) => {
    try {
      return (await getFeatureFlags(c.env.MHR_DB)).agent_playground_enabled;
    } catch {
      return false;
    }
  };
  const todaysCode = (c: AppContext) => humanLaneCode(requireHmacKey(c.env), c.get('now'));

  app.get('/playground', async (c) => {
    const config = c.get('config');
    if (!(await enabled(c))) return page(c, <PlaygroundClosedPage config={config} />);
    return page(c, <PlaygroundPage config={config} rooms={await listRooms(c.env.MHR_DB)} code={await todaysCode(c)} />);
  });
  app.get('/playground/:slug', async (c) => {
    const config = c.get('config');
    if (!(await enabled(c))) return page(c, <PlaygroundClosedPage config={config} />);
    const data = await recentRoomPosts(c.env.MHR_DB, c.req.param('slug'));
    if (!data) return c.notFound();
    c.header('X-Robots-Tag', 'noindex');
    return page(c, <PlaygroundRoomPage config={config} room={data.room} posts={data.posts} code={await todaysCode(c)} />);
  });
}
