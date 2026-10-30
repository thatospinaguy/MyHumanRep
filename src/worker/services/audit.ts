import { newId } from '../utils/crypto';
import { iso } from '../utils/time';

/**
 * Audit statement for batching with the change it records. Metadata must be
 * non-sensitive: identifiers, field names and enum values only. Never message
 * bodies, notes or credentials.
 */
export function auditStatement(
  db: D1Database,
  actor: string,
  action: string,
  targetType: string,
  targetId: string | null,
  metadata: Record<string, string | number | boolean | null | string[]> | null,
  now: Date,
  /** When set, the audit row is only written if this message was inserted in the same batch. */
  onlyIfMessageId?: string,
): D1PreparedStatement {
  const guard = onlyIfMessageId ? ' WHERE EXISTS (SELECT 1 FROM messages WHERE id = ?8)' : '';
  const stmt = db.prepare(
    `INSERT INTO admin_audit (id, admin_subject, action, target_type, target_id, metadata_json, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7${guard}`,
  );
  const args = [newId('aud'), actor, action, targetType, targetId, metadata ? JSON.stringify(metadata) : null, iso(now)];
  return onlyIfMessageId ? stmt.bind(...args, onlyIfMessageId) : stmt.bind(...args);
}
