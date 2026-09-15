import { sha256Hex, canonicalJson } from '../../utils/crypto.js';

/**
 * Deterministic hash chaining — ported from the PostgreSQL implementation
 * unchanged in intent. Database-agnostic: the chain's integrity does not depend
 * on the store, only on the canonical serialization and SHA-256.
 */
export const GENESIS_HASH = '0'.repeat(64);

/** The immutable content a record's hash commits to. Order-independent via canonicalJson. */
export function hashableContent(record) {
  return {
    tenantId: record.tenantId,
    sequence: record.sequence,
    actorId: record.actorId ?? null,
    actorRoleIds: [...(record.actorRoleIds ?? [])].sort(),
    permissionPath: record.permissionPath ?? null,
    action: record.action,
    entityType: record.entityType,
    entityId: record.entityId ?? null,
    requestId: record.requestId ?? null,
    networkAddress: record.networkAddress ?? null,
    outcome: record.outcome,
    payload: record.payload ?? {},
    occurredAt: new Date(record.occurredAt).toISOString(),
    prevHash: record.prevHash,
  };
}

export function computeRecordHash(record) {
  return sha256Hex(canonicalJson(hashableContent(record)));
}

/**
 * Given the current chain head (or null for genesis), produce the chain fields
 * for the next record.
 */
export function chainNext(previous, occurredAt) {
  const sequence = previous ? previous.sequence + 1 : 1;
  const prevHash = previous ? previous.hash : GENESIS_HASH;
  return { sequence, prevHash, occurredAt };
}
