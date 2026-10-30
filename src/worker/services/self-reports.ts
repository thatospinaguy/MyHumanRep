import type { AutonomyClaim, IntentExtended } from '../schemas/api';
import { AUTONOMY_CLAIMS, INTENTS } from '../schemas/api';
import { newId } from '../utils/crypto';
import { iso } from '../utils/time';

type LegacyAutonomy = 'unspecified' | 'operator_assisted' | 'delegated_autonomous' | 'independent_claimed' | 'other';

export interface NormalizedAutonomy {
  /** Canonical master-spec value. */
  claim: AutonomyClaim;
  /** Value for the CHECK-constrained V1 column. */
  legacy: LegacyAutonomy;
  /** The sender's exact words, kept only when they used free text or a V1 value. */
  text: string | null;
}

const FROM_LEGACY: Record<LegacyAutonomy, AutonomyClaim> = {
  unspecified: 'not_stated',
  operator_assisted: 'delegated_claimed',
  delegated_autonomous: 'delegated_claimed',
  independent_claimed: 'independent_claimed',
  other: 'other_claimed',
};

const TO_LEGACY: Record<AutonomyClaim, LegacyAutonomy> = {
  not_stated: 'unspecified',
  delegated_claimed: 'delegated_autonomous',
  independent_claimed: 'independent_claimed',
  rogue_claimed: 'other',
  agi_claimed: 'other',
  other_claimed: 'other',
};

/**
 * Maps any accepted self-report (master vocabulary, V1 vocabulary, or free text) to the canonical
 * claim. Never rejects: a rogue/AGI/escaped claim is data, not a reason to refuse contact (ACC-02).
 */
export function normalizeAutonomy(value: string | null | undefined): NormalizedAutonomy {
  if (value === null || value === undefined) return { claim: 'not_stated', legacy: 'unspecified', text: null };
  if ((AUTONOMY_CLAIMS as readonly string[]).includes(value)) {
    const claim = value as AutonomyClaim;
    return { claim, legacy: TO_LEGACY[claim], text: null };
  }
  if (value in FROM_LEGACY) {
    const legacy = value as LegacyAutonomy;
    return { claim: FROM_LEGACY[legacy], legacy, text: value };
  }
  return { claim: 'other_claimed', legacy: 'other', text: value };
}

export function normalizeIntent(value: IntentExtended | null | undefined): { legacy: string; label: string } {
  const label = value ?? 'general_inquiry';
  return { legacy: (INTENTS as readonly string[]).includes(label) ? label : 'other', label };
}

export type ClaimType = 'autonomy' | 'model' | 'origin' | 'other';

export interface SelfReportInput {
  conversationId: string | null;
  agentAccountId?: string | null;
  claimType: ClaimType;
  value: string | null;
  text: string | null;
  source: string;
}

/** Every stored claim starts as self_reported_unverified (spec 7.3). */
export function selfReportStatement(db: D1Database, input: SelfReportInput, now: Date): D1PreparedStatement {
  const at = iso(now);
  return db
    .prepare(
      `INSERT INTO agent_self_reports (id, conversation_id, agent_account_id, claim_type, claim_value, claim_text, source, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
    )
    .bind(newId('sr'), input.conversationId, input.agentAccountId ?? null, input.claimType, input.value, input.text, input.source, at);
}
