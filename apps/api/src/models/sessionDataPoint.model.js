import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { TARGET_MEASUREMENT_TYPE } from './enums.js';

/**
 * A single measurement captured during a session against one program target.
 * The shape is deliberately generic so it serves every measurement type without
 * a column per type: `value` carries the primary scalar (a count, a duration in
 * seconds, a rate, or a trials-to-criterion number) while `numerator` /
 * `denominator` carry the two components of a ratio (percent-correct, interval).
 * The service validates the right combination per measurement type; the pure
 * `sessions.rules` module owns that logic.
 *
 * Numeric measurements are structured clinical data, not free text — no PHI
 * narrative lives here (the session holds the sealed narrative). Referenced by
 * sessionId, with targetId / programId / treatmentPlanId denormalised for
 * tenant-scoped queries. Tenant-owned, versioned. Immutability after the parent
 * session is FROZEN is enforced by the service through the session guard.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    sessionId: { type: String, required: true },
    targetId: { type: String, required: true },
    programId: { type: String, default: null },
    treatmentPlanId: { type: String, required: true },
    measurementType: { type: String, enum: TARGET_MEASUREMENT_TYPE, required: true },
    value: { type: Number, default: null },
    numerator: { type: Number, default: null },
    denominator: { type: Number, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'sessionDataPoint' },
);
schema.plugin(tenantPlugin);
attributionFields(schema, { softDelete: true });
schema.index({ tenantId: 1, sessionId: 1 });
schema.index({ tenantId: 1, targetId: 1 });

export const SessionDataPoint = mongoose.model('SessionDataPoint', schema);
