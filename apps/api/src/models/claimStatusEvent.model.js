import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { CLAIM_STATUS } from './enums.js';

/**
 * An immutable record of a claim status transition. Tenant-owned, append-only:
 * preserves the previous and next status, actor and timestamp for a full audit
 * trail alongside the hash-chained audit log.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    claimId: { type: String, required: true, index: true },
    fromStatus: { type: String, enum: [...CLAIM_STATUS, null], default: null },
    toStatus: { type: String, enum: CLAIM_STATUS, required: true },
    reason: { type: String, default: null },
    actorId: { type: String, default: null },
    occurredAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true, versionKey: false, collection: 'claim_status_event' },
);
schema.plugin(tenantPlugin);
attributionFields(schema);

export const ClaimStatusEvent = mongoose.models.ClaimStatusEvent || mongoose.model('ClaimStatusEvent', schema);
