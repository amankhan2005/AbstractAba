import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';

/**
 * Tenant audit log — append-only, hash-chained per tenant.
 *
 * The PostgreSQL guarantees are reconstructed as follows (see ARCHITECTURE.md):
 *   - per-tenant sequence + hash chain: ported verbatim (audit.hash.js).
 *   - serialised chain head (was: pg_advisory_xact_lock): the unique index on
 *     (tenantId, sequence) makes two concurrent appends at the same sequence
 *     collide; the loser retries against the new head. Optimistic, scalable.
 *   - append-only (was: REVOKE UPDATE,DELETE): the repository exposes no update
 *     or delete, the schema blocks them below, AND the deployment's application
 *     MongoDB role is granted find+insert only on this collection.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    sequence: { type: Number, required: true },
    actorId: { type: String, default: null },
    actorRoleIds: { type: [String], default: [] },
    permissionPath: { type: String, default: null },
    action: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: { type: String, default: null },
    requestId: { type: String, default: null },
    networkAddress: { type: String, default: null },
    outcome: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    prevHash: { type: String, required: true },
    hash: { type: String, required: true },
    occurredAt: { type: Date, default: Date.now },
  },
  { versionKey: false, collection: 'audit_record' },
);
schema.plugin(tenantPlugin);
schema.index({ tenantId: 1, sequence: 1 }, { unique: true });
schema.index({ tenantId: 1, hash: 1 }, { unique: true });
schema.index({ tenantId: 1, occurredAt: -1 });
schema.index({ tenantId: 1, entityType: 1, entityId: 1 });
schema.index({ tenantId: 1, action: 1 });

// Defence in depth: block mutation at the model even if a caller bypasses the
// repository. The deployment role is the real REVOKE; this catches app bugs.
function blockMutation(next) {
  next(new Error('audit_record is append-only: update/delete are not permitted'));
}
for (const hook of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete']) {
  schema.pre(hook, blockMutation);
}

export const AuditRecord = mongoose.model('AuditRecord', schema);
