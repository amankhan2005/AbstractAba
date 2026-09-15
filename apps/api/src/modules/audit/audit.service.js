import { auditRepository } from './audit.repository.js';
import { computeRecordHash, GENESIS_HASH } from './audit.hash.js';
import { logger } from '../../config/logger.js';

/**
 * Audit service. `record` appends; `verify` walks a tenant's chain and confirms
 * every link and hash — the tamper-detection guarantee that backs append-only.
 */
export class AuditService {
  constructor(repo = auditRepository) {
    this.repo = repo;
  }

  async record(input) {
    // Never store PHI: payload is metadata only. Callers are responsible, and
    // the audit catalogue (see rbac/audit integration) governs what is emitted.
    return this.repo.append(input);
  }

  async query(tenantId, q) {
    return this.repo.query(tenantId, q);
  }

  /** Verify the full chain for a tenant. Returns { ok, checked, brokenAt? }. */
  async verify(tenantId) {
    const chain = await this.repo.listChain(tenantId);
    let expectedPrev = GENESIS_HASH;
    let expectedSeq = 1;
    for (const rec of chain) {
      if (rec.sequence !== expectedSeq) {
        return { ok: false, checked: expectedSeq - 1, brokenAt: rec.sequence, reason: 'sequence-gap' };
      }
      if (rec.prevHash !== expectedPrev) {
        return { ok: false, checked: expectedSeq - 1, brokenAt: rec.sequence, reason: 'prev-hash-mismatch' };
      }
      if (computeRecordHash(rec) !== rec.hash) {
        return { ok: false, checked: expectedSeq - 1, brokenAt: rec.sequence, reason: 'hash-mismatch' };
      }
      expectedPrev = rec.hash;
      expectedSeq += 1;
    }
    return { ok: true, checked: chain.length };
  }
}

export const auditService = new AuditService();

/** Fire-and-forget recorder used by middleware; a failed audit must never break a request path silently — it logs. */
export function recordSafely(input) {
  auditService.record(input).catch((err) => logger.error({ err: err.message, action: input.action }, 'audit append failed'));
}
