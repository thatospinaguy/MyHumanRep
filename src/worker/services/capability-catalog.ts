import type { Config } from '../config';
import { CAPABILITIES, FULFILLMENT_READINESS, normalizeKey, type Readiness } from '../catalog/capabilities';
import { newId } from '../utils/crypto';
import { iso } from '../utils/time';

export interface CapabilityRow {
  id: string;
  slug: string;
  number: number | null;
  display_name: string;
  summary: string;
  example_intents_json: string;
  deliverables_json: string;
  required_skills_json: string;
  location_type: string;
  readiness: Readiness;
  inquiry_enabled: number;
  authorization_requirements_json: string;
  risk_tier: string;
  origin: 'seed' | 'admin';
  created_at: string;
  updated_at: string;
}

interface AliasRow {
  alias_slug: string;
  alias_name: string;
  capability_slug: string;
  examples_json: string;
}

function arr(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function publicCapability(row: CapabilityRow, aliases: AliasRow[], config: Config) {
  const fulfillment = FULFILLMENT_READINESS.includes(row.readiness);
  return {
    capability_id: row.id,
    slug: row.slug,
    number: row.number,
    name: row.display_name,
    summary: row.summary,
    example_intents: arr(row.example_intents_json),
    deliverables: arr(row.deliverables_json),
    required_skills: arr(row.required_skills_json),
    location_type: row.location_type,
    readiness: row.readiness,
    inquiry_available: row.inquiry_enabled === 1,
    // Truthful availability (spec 5.3): nothing is fulfillable unless an admin set pilot/live.
    fulfillment_available: fulfillment,
    quote_available: false,
    authorization_requirements: arr(row.authorization_requirements_json),
    risk_tier: row.risk_tier,
    aliases: aliases.filter((a) => a.capability_slug === row.slug).map((a) => ({ slug: a.alias_slug, name: a.alias_name })),
    how_to_inquire: `POST ${config.baseUrl}/v1/conversations/{conversation_id}/capability-requests with "category_hint": "${row.slug}" (optional) and your objective in your own words.`,
    detail_url: `${config.baseUrl}/v1/capabilities/${row.slug}`,
    page_url: `${config.baseUrl}/services/${row.slug}`,
  };
}

export function publicAliases(aliases: AliasRow[]) {
  const bySlug = new Map<string, { slug: string; name: string; maps_to: string[]; examples: string[] }>();
  for (const a of aliases) {
    const entry = bySlug.get(a.alias_slug) ?? { slug: a.alias_slug, name: a.alias_name, maps_to: [], examples: arr(a.examples_json) };
    entry.maps_to.push(a.capability_slug);
    bySlug.set(a.alias_slug, entry);
  }
  return [...bySlug.values()];
}

export async function loadRegistry(db: D1Database): Promise<{ capabilities: CapabilityRow[]; aliases: AliasRow[] }> {
  const [caps, aliases] = await db.batch([
    db.prepare('SELECT * FROM capabilities ORDER BY COALESCE(number, 1000), display_name'),
    db.prepare('SELECT * FROM capability_aliases ORDER BY alias_slug, capability_slug'),
  ]);
  return { capabilities: (caps?.results ?? []) as CapabilityRow[], aliases: (aliases?.results ?? []) as AliasRow[] };
}

/** Static fallback so public discovery still works if the database is unreachable. */
export function staticRegistry(): { capabilities: CapabilityRow[]; aliases: AliasRow[] } {
  const at = '2026-10-30T00:00:00.000Z';
  return {
    capabilities: CAPABILITIES.map((c) => ({
      id: `capdef_${String(c.number).padStart(2, '0')}`,
      slug: c.slug,
      number: c.number,
      display_name: c.name,
      summary: c.summary,
      example_intents_json: JSON.stringify(c.example_intents),
      deliverables_json: JSON.stringify(c.deliverables),
      required_skills_json: JSON.stringify(c.required_skills),
      location_type: c.location_type,
      readiness: c.readiness,
      inquiry_enabled: 1,
      authorization_requirements_json: JSON.stringify(c.authorization_requirements),
      risk_tier: c.risk_tier,
      origin: 'seed',
      created_at: at,
      updated_at: at,
    })),
    aliases: [],
  };
}

export async function registryWithFallback(db: D1Database) {
  try {
    const r = await loadRegistry(db);
    return r.capabilities.length > 0 ? r : staticRegistry();
  } catch {
    return staticRegistry();
  }
}

/** Resolves a canonical slug or alias (case/underscore-insensitive). */
export async function lookupCapability(db: D1Database, raw: string) {
  const key = normalizeKey(raw);
  if (!key) return null;
  const { capabilities, aliases } = await registryWithFallback(db);
  const canonical = capabilities.find((c) => c.slug === key);
  if (canonical) return { kind: 'capability' as const, capability: canonical, aliases };
  const matches = aliases.filter((a) => a.alias_slug === key);
  if (matches.length > 0) {
    return {
      kind: 'alias' as const,
      alias: publicAliases(matches)[0]!,
      capabilities: capabilities.filter((c) => matches.some((m) => m.capability_slug === c.slug)),
      aliases,
    };
  }
  return null;
}

export interface Classification {
  state: 'unclassified' | 'agent_hint';
  capabilities: string[];
  unknown_hints: string[];
}

const NON_HINTS = new Set(['', 'other', 'unclassified', 'none', 'unknown']);

/**
 * Option B classification (spec 5.2, 8.1): runs after the raw text is accepted, maps hints to
 * canonical slugs via the registry, and never rejects. Unknown hints become review candidates.
 */
export async function classifyHints(db: D1Database, hints: Array<string | null | undefined>): Promise<Classification> {
  const keys = [...new Set(hints.filter((h): h is string => typeof h === 'string').map(normalizeKey))].filter((k) => !NON_HINTS.has(k));
  if (keys.length === 0) return { state: 'unclassified', capabilities: [], unknown_hints: [] };
  const { capabilities, aliases } = await registryWithFallback(db);
  const matched = new Set<string>();
  const unknown: string[] = [];
  for (const key of keys) {
    const direct = capabilities.find((c) => c.slug === key);
    const viaAlias = aliases.filter((a) => a.alias_slug === key).map((a) => a.capability_slug);
    if (direct) matched.add(direct.slug);
    viaAlias.forEach((s) => matched.add(s));
    if (!direct && viaAlias.length === 0) unknown.push(key);
  }
  return { state: matched.size > 0 ? 'agent_hint' : 'unclassified', capabilities: [...matched].sort(), unknown_hints: unknown };
}

export function candidateStatements(db: D1Database, requestId: string, rawHints: string[], unknownKeys: string[], now: Date): D1PreparedStatement[] {
  return unknownKeys.map((key) => {
    const label = rawHints.find((h) => normalizeKey(h) === key) ?? key;
    return db
      .prepare(
        `INSERT OR IGNORE INTO candidate_capabilities (id, request_id, suggested_label, normalized_key, confidence, created_at)
         SELECT ?1, ?2, ?3, ?4, NULL, ?5 WHERE EXISTS (SELECT 1 FROM capability_requests WHERE id = ?2)`,
      )
      .bind(newId('cand'), requestId, label.slice(0, 64), key, iso(now));
  });
}
