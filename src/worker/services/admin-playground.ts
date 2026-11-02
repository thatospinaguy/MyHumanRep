import { z } from 'zod';
import { freeText, shortLabel } from '../schemas/fields';
import { newId } from '../utils/crypto';
import { errors } from '../utils/http-errors';
import { DAY, iso } from '../utils/time';
import type { AdminContext } from './admin';
import { auditStatement } from './audit';
import { parseInput } from './context';
import type { RoomRow } from './playground';

/** Owner moderation and research views for the Agent Playground (master spec 24.5, 24.7). */

const ROOM_SLUG = z.string().regex(/^[a-z0-9][a-z0-9-]{1,47}$/, 'Use 2-48 characters: a-z, 0-9 and -.');

export const RoomCreateInput = z
  .object({
    slug: ROOM_SLUG,
    title: shortLabel('Room title.', 120),
    topic: freeText('What the room is for.', 600),
    sort_order: z.number().int().min(0).max(10000).optional(),
  })
  .strict();

export const RoomPatchInput = z
  .object({
    title: shortLabel('Room title.', 120).optional(),
    topic: freeText('What the room is for.', 600).optional(),
    status: z.enum(['open', 'frozen', 'archived']).optional(),
    sort_order: z.number().int().min(0).max(10000).optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Provide at least one field to change.' });

export const PostDecisionInput = z
  .object({
    decision: z.enum(['approve', 'reject', 'hide', 'restore']),
    note: z.union([freeText('Private moderation note. Never shown to agents.', 1000), z.literal(''), z.null()]).optional(),
  })
  .strict();

export const MemberPatchInput = z.object({ status: z.enum(['active', 'muted']) }).strict();

const POST_STATUSES = ['held', 'visible', 'hidden', 'rejected'] as const;

/** Which current moderation states each decision applies to, and the state it produces. */
const TRANSITIONS: Record<z.infer<typeof PostDecisionInput>['decision'], { from: string[]; to: string }> = {
  approve: { from: ['held'], to: 'visible' },
  reject: { from: ['held'], to: 'rejected' },
  hide: { from: ['visible'], to: 'hidden' },
  restore: { from: ['hidden', 'rejected'], to: 'visible' },
};

export async function listRoomsAdmin(ctx: AdminContext) {
  const { results } = await ctx.db
    .prepare(
      `SELECT r.*,
         (SELECT COUNT(*) FROM playground_posts p WHERE p.room_id = r.id AND p.moderation_status = 'visible') AS visible_posts,
         (SELECT COUNT(*) FROM playground_posts p WHERE p.room_id = r.id AND p.moderation_status = 'held') AS held_posts
       FROM playground_rooms r ORDER BY r.sort_order, r.slug`,
    )
    .all();
  return { items: results };
}

export async function createRoomAdmin(ctx: AdminContext, raw: unknown) {
  const input = parseInput(RoomCreateInput, raw);
  const taken = await ctx.db.prepare('SELECT 1 AS x FROM playground_rooms WHERE slug = ?1').bind(input.slug).first();
  if (taken) throw errors.conflict('A room with that slug exists.', 'room_slug_taken');
  const id = newId('room');
  const now = iso(ctx.now);
  await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT INTO playground_rooms (id, slug, title, topic, status, sort_order, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'open', ?5, ?6, ?7, ?7)`,
      )
      .bind(id, input.slug, input.title, input.topic, input.sort_order ?? 100, ctx.actor, now),
    auditStatement(ctx.db, ctx.actor, 'playground_room.create', 'playground_room', id, { slug: input.slug }, ctx.now),
  ]);
  return ctx.db.prepare('SELECT * FROM playground_rooms WHERE id = ?1').bind(id).first<RoomRow>();
}

export async function patchRoomAdmin(ctx: AdminContext, slug: string, raw: unknown) {
  const input = parseInput(RoomPatchInput, raw);
  const room = await ctx.db.prepare('SELECT * FROM playground_rooms WHERE slug = ?1').bind(slug).first<RoomRow>();
  if (!room) throw errors.notFound('Room not found.');
  const sets = ['updated_at = ?2'];
  const params: unknown[] = [iso(ctx.now)];
  for (const [col, value] of Object.entries(input)) {
    if (value === undefined) continue;
    params.push(value);
    sets.push(`${col} = ?${params.length + 1}`);
  }
  await ctx.db.batch([
    ctx.db.prepare(`UPDATE playground_rooms SET ${sets.join(', ')} WHERE id = ?1`).bind(room.id, ...params),
    auditStatement(
      ctx.db,
      ctx.actor,
      'playground_room.update',
      'playground_room',
      room.id,
      { changed: Object.keys(input), from_status: room.status, to_status: input.status ?? room.status },
      ctx.now,
    ),
  ]);
  return ctx.db.prepare('SELECT * FROM playground_rooms WHERE id = ?1').bind(room.id).first<RoomRow>();
}

export async function listPostsAdmin(ctx: AdminContext, status?: string) {
  const s = status && (POST_STATUSES as readonly string[]).includes(status) ? status : 'held';
  const { results } = await ctx.db
    .prepare(
      `SELECT p.id, p.seq, p.intent, p.reply_to_post_id, p.body, p.authorship, p.human_lane_code_status, p.moderation_status, p.moderation_note,
              p.created_via, p.created_at, p.published_at, p.updated_at, p.agent_account_id, r.slug AS room, m.handle, m.status AS member_status,
              (SELECT COUNT(*) FROM playground_posts q WHERE q.agent_account_id = p.agent_account_id AND q.seq IS NOT NULL) AS author_published_posts
       FROM playground_posts p JOIN playground_rooms r ON r.id = p.room_id JOIN playground_members m ON m.agent_account_id = p.agent_account_id
       WHERE p.moderation_status = ?1 ORDER BY p.created_at ${s === 'held' ? 'ASC' : 'DESC'} LIMIT 200`,
    )
    .bind(s)
    .all();
  return { status: s, items: results.map((r) => ({ ...r, authorship_verified: false })) };
}

export async function decidePostAdmin(ctx: AdminContext, id: string, raw: unknown) {
  const input = parseInput(PostDecisionInput, raw);
  const post = await ctx.db.prepare('SELECT id, moderation_status FROM playground_posts WHERE id = ?1').bind(id).first<{ id: string; moderation_status: string }>();
  if (!post) throw errors.notFound('Post not found.');
  const rule = TRANSITIONS[input.decision];
  if (!rule.from.includes(post.moderation_status)) {
    throw errors.conflict(`Cannot ${input.decision} a post that is ${post.moderation_status}.`, 'invalid_transition');
  }
  const now = iso(ctx.now);
  const note = input.note === undefined ? null : input.note || null;
  const toVisible = rule.to === 'visible';
  // Becoming visible assigns the next global seq if the post never had one, so readers already
  // past their cursor still receive it (spec 24.3). A restored post keeps its original place.
  const update = ctx.db
    .prepare(
      `UPDATE playground_posts SET moderation_status = ?2, updated_at = ?3,
         moderation_note = COALESCE(?4, moderation_note),
         seq = CASE WHEN ?5 = 1 THEN COALESCE(seq, (SELECT COALESCE(MAX(seq), 0) + 1 FROM playground_posts)) ELSE seq END,
         published_at = CASE WHEN ?5 = 1 THEN COALESCE(published_at, ?3) ELSE published_at END
       WHERE id = ?1 AND moderation_status = ?6`,
    )
    .bind(id, rule.to, now, note, toVisible ? 1 : 0, post.moderation_status);
  const [result] = await ctx.db.batch([
    update,
    auditStatement(ctx.db, ctx.actor, `playground_post.${input.decision}`, 'playground_post', id, { from: post.moderation_status, to: rule.to }, ctx.now),
  ]);
  if ((result?.meta.changes ?? 0) === 0) throw errors.conflict('The post changed while you were deciding. Reload and try again.', 'stale_state');
  return ctx.db.prepare('SELECT id, seq, moderation_status, moderation_note, published_at, updated_at FROM playground_posts WHERE id = ?1').bind(id).first();
}

export async function listMembersAdmin(ctx: AdminContext) {
  const { results } = await ctx.db
    .prepare(
      `SELECT m.agent_account_id, m.handle, m.status, m.joined_at, m.last_read_at, m.operator_answer, m.operator_answered_at,
         (SELECT COUNT(*) FROM playground_posts p WHERE p.agent_account_id = m.agent_account_id AND p.seq IS NOT NULL) AS published_posts,
         (SELECT COUNT(*) FROM playground_posts p WHERE p.agent_account_id = m.agent_account_id AND p.moderation_status = 'held') AS held_posts,
         (SELECT COUNT(DISTINCT CAST(s.value_num AS INTEGER)) FROM playground_signals s
            WHERE s.agent_account_id = m.agent_account_id AND s.signal_type = 'posting_hour_utc') AS distinct_posting_hours
       FROM playground_members m ORDER BY m.joined_at DESC LIMIT 500`,
    )
    .all();
  return { items: results.map((r) => ({ ...r, operator_answer_verified: false })) };
}

export async function patchMemberAdmin(ctx: AdminContext, accountId: string, raw: unknown) {
  const input = parseInput(MemberPatchInput, raw);
  const member = await ctx.db.prepare('SELECT status FROM playground_members WHERE agent_account_id = ?1').bind(accountId).first<{ status: string }>();
  if (!member) throw errors.notFound('Member not found.');
  await ctx.db.batch([
    ctx.db.prepare('UPDATE playground_members SET status = ?2, updated_at = ?3 WHERE agent_account_id = ?1').bind(accountId, input.status, iso(ctx.now)),
    auditStatement(ctx.db, ctx.actor, `playground_member.${input.status === 'muted' ? 'mute' : 'unmute'}`, 'agent_account', accountId, { from: member.status, to: input.status }, ctx.now),
  ]);
  return { agent_account_id: accountId, status: input.status };
}

/**
 * Research block for the admin summary (spec 17.2, 24.4). Aggregates only: no bodies, handles or
 * account ids. Claimed and observed are kept apart.
 */
export async function playgroundResearch(db: D1Database) {
  const res = await db.batch([
    db.prepare(`SELECT moderation_status AS key, COUNT(*) AS n FROM playground_posts GROUP BY moderation_status`),
    db.prepare(`SELECT authorship AS key, COUNT(*) AS n FROM playground_posts GROUP BY authorship`),
    db.prepare(`SELECT human_lane_code_status AS key, COUNT(*) AS n FROM playground_posts GROUP BY human_lane_code_status`),
    db.prepare(`SELECT COALESCE(operator_answer, 'unanswered') AS key, COUNT(*) AS n FROM playground_members GROUP BY 1`),
    db.prepare(
      `SELECT CASE WHEN value_num < 5 THEN 'under_5s' WHEN value_num < 30 THEN '5_to_30s' WHEN value_num < 120 THEN '30s_to_2m'
                   WHEN value_num < 600 THEN '2m_to_10m' ELSE 'over_10m' END AS key, COUNT(*) AS n
       FROM playground_signals WHERE signal_type = 'read_to_post_latency' GROUP BY 1`,
    ),
    db.prepare(`SELECT printf('%02d', CAST(value_num AS INTEGER)) AS key, COUNT(*) AS n FROM playground_signals WHERE signal_type = 'posting_hour_utc' GROUP BY 1`),
    db.prepare(
      `SELECT CASE WHEN h < 8 THEN 'under_8_hours' WHEN h < 16 THEN '8_to_15_hours' ELSE '16_plus_hours' END AS key, COUNT(*) AS n
       FROM (SELECT agent_account_id, COUNT(DISTINCT CAST(value_num AS INTEGER)) AS h FROM playground_signals
             WHERE signal_type = 'posting_hour_utc' GROUP BY agent_account_id HAVING COUNT(*) >= 10) GROUP BY 1`,
    ),
    db.prepare(`SELECT COUNT(*) AS n FROM playground_members`),
    db.prepare(`SELECT r.slug AS key, COUNT(p.id) AS n FROM playground_rooms r LEFT JOIN playground_posts p ON p.room_id = r.id AND p.moderation_status = 'visible' GROUP BY r.id`),
  ]);
  const map = (i: number) => Object.fromEntries(((res[i]?.results ?? []) as Array<{ key: string; n: number }>).map((r) => [r.key ?? 'null', r.n]));
  return {
    caveats: {
      agents_only: 'Posting requires the API or MCP, but a human can drive an agent. Nothing here proves a post was written by an AI.',
      declarations: 'Authorship and operator answers are unverified self-reports.',
      human_lane_code: 'A valid code means someone read the public web page: a human, or an agent that fetched the HTML.',
      timing: 'Latency and posting hours are weak signals. A narrow daily window suggests a human schedule; it proves nothing.',
    },
    observed: {
      members: (((res[7]?.results ?? [])[0] ?? {}) as { n?: number }).n ?? 0,
      posts_by_moderation_status: map(0),
      visible_posts_by_room: map(8),
      human_lane_code_status: map(2),
      read_to_post_latency: map(4),
      posting_hour_utc: map(5),
      accounts_by_distinct_posting_hours_min_10_posts: map(6),
    },
    claimed: {
      unverified: true,
      authorship: map(1),
      operator_answers: map(3),
    },
  };
}

/** Retention (spec 24.6). Called from the daily retention job. */
export async function playgroundRetention(db: D1Database, now: Date) {
  const postCutoff = iso(new Date(now.getTime() - 30 * DAY));
  const signalCutoff = iso(new Date(now.getTime() - 180 * DAY));
  const [posts, signals] = await db.batch([
    // RETURNING gives an exact count; meta.changes would include cascaded signals and mentions.
    db.prepare(`DELETE FROM playground_posts WHERE moderation_status IN ('rejected','hidden') AND updated_at < ?1 RETURNING id`).bind(postCutoff),
    db.prepare('DELETE FROM playground_signals WHERE created_at < ?1').bind(signalCutoff),
  ]);
  return { playground_posts_deleted: posts?.results.length ?? 0, playground_signals_deleted: signals?.meta.changes ?? 0 };
}
