import mongoose from 'mongoose';
import { newId } from '../utils/id.js';

/**
 * Durable job queue. Platform-scoped infrastructure: the worker claims across
 * every tenant, so NO tenant plugin. `tenantId` is stored for attribution and
 * to re-establish tenant context in a handler. Mutable live queue state.
 * Unique (tenantId, type, idempotencyKey) makes enqueue idempotent; the
 * (status, runAt) index backs the atomic findOneAndUpdate claim.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    type: { type: String, required: true },
    tenantId: { type: String, default: null },
    actorId: { type: String, default: null },
    payload: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    idempotencyKey: { type: String, default: null },
    status: { type: String, default: 'pending', index: true }, // pending|running|succeeded|failed|dead
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, required: true },
    runAt: { type: Date, required: true },
    claimedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'job' },
);
schema.index({ tenantId: 1, type: 1, idempotencyKey: 1 }, { unique: true, sparse: true });
schema.index({ status: 1, runAt: 1 });

export const Job = mongoose.model('Job', schema);
