import { z } from 'zod';
import type { Config } from '../config';
import { iso } from '../utils/time';

/** Owner-editable, non-secret settings. Keys and ranges are whitelisted. */
export const SettingsSchema = z
  .object({
    intake_enabled: z.boolean(),
    intake_paused_message: z.string().min(1).max(300),
    conversation_ttl_days: z.number().int().min(1).max(365),
    expired_grace_days: z.number().int().min(0).max(90),
    abuse_retention_days: z.number().int().min(1).max(90),
    audit_retention_days: z.number().int().min(7).max(730),
    notifications_enabled: z.boolean(),
    first_contact_per_source_per_hour: z.number().int().min(1).max(100000),
    first_contact_global_per_day: z.number().int().min(1).max(1000000),
  })
  .strict();
export type Settings = z.infer<typeof SettingsSchema>;

export const SettingsPatchSchema = SettingsSchema.partial().strict();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export function defaultSettings(config: Config): Settings {
  return {
    intake_enabled: config.intakeEnabledDefault,
    intake_paused_message: 'New inquiries are temporarily paused. Existing conversations continue to work.',
    conversation_ttl_days: config.defaultRetentionDays,
    expired_grace_days: 7,
    abuse_retention_days: 7,
    audit_retention_days: 90,
    notifications_enabled: true,
    first_contact_per_source_per_hour: config.limits.firstContactPerSourcePerHour,
    first_contact_global_per_day: config.limits.firstContactGlobalPerDay,
  };
}

export async function getSettings(db: D1Database, config: Config): Promise<Settings> {
  const settings = defaultSettings(config);
  const { results } = await db.prepare('SELECT key, value_json FROM settings').all<{ key: string; value_json: string }>();
  const merged: Record<string, unknown> = { ...settings };
  for (const row of results) {
    if (!(row.key in settings)) continue;
    try {
      merged[row.key] = JSON.parse(row.value_json) as unknown;
    } catch {
      // Ignore a corrupt row; keep the default.
    }
  }
  const parsed = SettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : settings;
}

export function settingsUpsertStatements(db: D1Database, patch: SettingsPatch, actor: string, now: Date): D1PreparedStatement[] {
  return Object.entries(patch)
    .filter(([, v]) => v !== undefined)
    .map(([key, value]) =>
      db
        .prepare(
          `INSERT INTO settings (key, value_json, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        )
        .bind(key, JSON.stringify(value), iso(now), actor),
    );
}
