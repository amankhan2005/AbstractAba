import { AuditRecord } from '../../models/index.js';
import { withTenant, currentTenantId } from '../../tenancy/tenantContext.js';
import { newId } from '../../utils/id.js';
import { computeRecordHash, chainNext, GENESIS_HASH } from './audit.hash.js';

const MAX_APPEND_RETRIES = 5;

/**
 * Append-only, hash-chained audit repository (MongoDB).
 *
 * Serialising the chain head — the job PostgreSQL did with a per-tenant
 * `pg_advisory_xact_lock` — is done here with OPTIMISTIC CONCURRENCY on the
 * `(tenantId, sequence)` unique index. Two writers that read the same head
 * compute the same next sequence; exactly one insert succeeds, the other hits a
 * duplicate-key error (11000) and retries against the now-advanced head. This
 * needs no lock, scales horizontally, and preserves a gapless chain.
 *
 * Append runs inside withTenant() so the tenant plugin scopes the head read and
 * stamps the insert — the tenant can only extend its own chain.
 */
export class AuditRepository {
  async append(input) {
    return withTenant(input.tenantId, async () => {
      let lastErr;
      for (let attempt = 0; attempt < MAX_APPEND_RETRIES; attempt += 1) {
        const previous = await AuditRecord.findOne({})
          .sort({ sequence: -1 })
          .select({ sequence: 1, hash: 1 })
          .lean();

        const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
        const { sequence, prevHash } = chainNext(
          previous ? { sequence: previous.sequence, hash: previous.hash } : null,
          occurredAt,
        );

        const draft = {
          _id: newId(),
          tenantId: input.tenantId,
          sequence,
          actorId: input.actorId ?? null,
          actorRoleIds: input.actorRoleIds ?? [],
          permissionPath: input.permissionPath ?? null,
          action: input.action,
          entityType: input.entityType,
          entityId: input.entityId ?? null,
          requestId: input.requestId ?? null,
          networkAddress: input.networkAddress ?? null,
          outcome: input.outcome,
          payload: input.payload ?? {},
          prevHash,
          occurredAt,
        };
        draft.hash = computeRecordHash(draft);

        try {
          const [created] = await AuditRecord.create([draft]);
          return created.toObject();
        } catch (err) {
          if (err && err.code === 11000) {
            lastErr = err;
            continue; // head advanced under us — recompute and retry
          }
          throw err;
        }
      }
      throw lastErr ?? new Error('audit append failed to serialise');
    });
  }

  async listChain(tenantId) {
    return withTenant(tenantId, async () =>
      AuditRecord.find({}).sort({ sequence: 1 }).lean(),
    );
  }

  async query(tenantId, q = {}) {
    return withTenant(tenantId, async () => {
      const filter = {};
      if (q.action) filter.action = q.action;
      if (q.entityType) filter.entityType = q.entityType;
      if (q.entityId) filter.entityId = q.entityId;
      if (q.actorId) filter.actorId = q.actorId;
      if (q.from || q.to) {
        filter.occurredAt = {};
        if (q.from) filter.occurredAt.$gte = new Date(q.from);
        if (q.to) filter.occurredAt.$lte = new Date(q.to);
      }
      const limit = Math.min(q.limit ?? 100, 500);
      return AuditRecord.find(filter).sort({ sequence: -1 }).limit(limit).lean();
    });
  }
}

export { GENESIS_HASH };
export const auditRepository = new AuditRepository();
