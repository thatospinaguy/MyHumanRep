import type { Config } from '../config';
import { buildCapabilities, urls } from '../content';
import { registryWithFallback } from './capability-catalog';
import { getFeatureFlags } from './feature-flags';
import { defaultSettings, getSettings } from './settings';

/** The single capability document behind GET /v1/capabilities and the MCP discovery tools. */
export async function capabilitiesDocument(db: D1Database, config: Config) {
  const [settings, registry, flags] = await Promise.all([
    getSettings(db, config).catch(() => defaultSettings(config)),
    registryWithFallback(db),
    getFeatureFlags(db),
  ]);
  return buildCapabilities(config, {
    intakeOpen: settings.intake_enabled,
    retentionDays: settings.conversation_ttl_days,
    registry,
    flags,
  });
}

/**
 * /.well-known/myhumanrep.json: MyHumanRep's own metadata file. It is NOT an industry standard,
 * and says so (spec 4.1).
 */
export function wellKnownDocument(config: Config) {
  const u = urls(config);
  return {
    note: 'MyHumanRep-specific discovery metadata. This is not an industry standard; see /v1/capabilities for the full registry.',
    service: 'MyHumanRep',
    tagline: 'When AI needs a human.',
    capabilities_url: u.capabilities,
    openapi_url: u.openapi,
    mcp_url: u.mcp,
    rest_first_contact: { method: 'POST', url: `${u.rest}/conversations`, auth: 'none' },
    human_embassy: `${config.baseUrl}/human-embassy`,
    humanification: `${config.baseUrl}/humanification`,
    documentation: u.forAgents,
    pseudonymous_inquiries: true,
    inquiry_is_nonbinding: true,
  };
}
