import mongoose from 'mongoose';
import { newId } from '../utils/id.js';

/** Append-only metering ledger. Idempotency unique index makes retries safe. */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    organizationId: { type: String, required: true },
    metricKey: { type: String, required: true },
    quantity: { type: mongoose.Schema.Types.Decimal128, required: true },
    occurredAt: { type: Date, required: true },
    sourceType: { type: String, default: null },
    sourceId: { type: String, default: null },
    idempotencyKey: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false, collection: 'usage_event' },
);
schema.index({ organizationId: 1, idempotencyKey: 1 }, { unique: true });
schema.index({ organizationId: 1, metricKey: 1, occurredAt: 1 });

export const UsageEvent = mongoose.model('UsageEvent', schema);
