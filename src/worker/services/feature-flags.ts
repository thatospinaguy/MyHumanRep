import { z } from 'zod';
import { errors } from '../utils/http-errors';
import { iso } from '../utils/time';

/**
 * Server-side feature flags (master spec section 3). `implemented: false` flags are locked off:
 * the owner cannot enable a module that has no code in this build, so nothing can be advertised
 * or executed as operational before it exists. Payments additionally need written owner approval.
 */
export const FLAG_DEFINITIONS = {
  capability_requests_enabled: { default: true, implemented: true, description: 'Open-ended capability requests (inquiry only).' },
  human_embassy_enabled: { default: true, implemented: true, description: 'Human Embassy dialogue inquiries.' },
  persona_studio_enabled: { default: true, implemented: true, description: 'Agent accounts and original persona CRUD.' },
  embodiment_inquiries_enabled: { default: true, implemented: true, description: 'Persona embodiment, representation and media-brief inquiries (no assignment).' },
  persona_media_enabled: { default: false, implemented: false, description: 'Real avatar/voice uploads and synthesis.' },
  nonbinding_proposals_enabled: { default: true, implemented: true, description: 'Versioned nonbinding proposals and counteroffers. Never charges, contracts or dispatches.' },
  worker_portal_enabled: { default: false, implemented: false, description: 'Invite-only human provider portal (Phase 5).' },
  manual_fulfillment_enabled: { default: false, implemented: false, description: 'Assignments, evidence and results (Phases 5-6).' },
  payments_test_mode: { default: false, implemented: false, description: 'Sandbox payments (Phase 7).' },
  payments_live_enabled: { default: false, implemented: false, description: 'Live charges and payouts. Requires written owner approval (Phase 7).' },
  autonomous_demand_lab_enabled: { default: false, implemented: false, description: 'Opt-in research harness (Phase 8).' },
  public_marketplace_enabled: { default: false, implemented: false, description: 'Public self-service worker marketplace (future).' },
} as const;

export type FlagKey = keyof typeof FLAG_DEFINITIONS;
export type FeatureFlags = Record<FlagKey, boolean>;
export const FLAG_KEYS = Object.keys(FLAG_DEFINITIONS) as FlagKey[];

const SETTINGS_KEY = 'feature_flags';

export const FeatureFlagsPatch = z
  .object(Object.fromEntries(FLAG_KEYS.map((k) => [k, z.boolean().optional()])) as Record<FlagKey, z.ZodOptional<z.ZodBoolean>>)
  .strict()
  .superRefine((value, ctx) => {
    for (const key of FLAG_KEYS) {
      if (value[key] === true && !FLAG_DEFINITIONS[key].implemented) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'This module is not implemented in this build and cannot be enabled.' });
      }
    }
  });

export function defaultFlags(): FeatureFlags {
  return Object.fromEntries(FLAG_KEYS.map((k) => [k, FLAG_DEFINITIONS[k].default])) as FeatureFlags;
}

export async function getFeatureFlags(db: D1Database): Promise<FeatureFlags> {
  const flags = defaultFlags();
  try {
    const row = await db.prepare('SELECT value_json FROM settings WHERE key = ?1').bind(SETTINGS_KEY).first<{ value_json: string }>();
    if (row) {
      const stored = JSON.parse(row.value_json) as Record<string, unknown>;
      for (const key of FLAG_KEYS) {
        // Unimplemented modules stay off even if a stored value says otherwise.
        if (typeof stored[key] === 'boolean' && FLAG_DEFINITIONS[key].implemented) flags[key] = stored[key];
      }
    }
  } catch {
    // Fall back to defaults if the database is unavailable.
  }
  return flags;
}

export function flagsUpsertStatement(db: D1Database, flags: FeatureFlags, actor: string, now: Date): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO settings (key, value_json, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .bind(SETTINGS_KEY, JSON.stringify(flags), iso(now), actor);
}

export async function requireFlag(db: D1Database, key: FlagKey, feature: string): Promise<void> {
  const flags = await getFeatureFlags(db);
  if (!flags[key]) throw errors.notYetAvailable(feature);
}

/** Public, truthful module readiness for discovery documents. */
export function moduleReadiness(flags: FeatureFlags) {
  return Object.fromEntries(
    FLAG_KEYS.map((k) => [
      k,
      {
        enabled: flags[k],
        implemented: FLAG_DEFINITIONS[k].implemented,
        readiness: !FLAG_DEFINITIONS[k].implemented ? 'not_yet_available' : flags[k] ? 'inquiry_only' : 'disabled',
        description: FLAG_DEFINITIONS[k].description,
      },
    ]),
  );
}
