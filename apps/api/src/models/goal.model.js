import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { GOAL_TERM, GOAL_STATUS } from './enums.js';

/**
 * A goal within a treatment plan — long-term or short-term, prioritised, with a
 * status and a 0–100 progress reading. Tenant-owned, versioned. Referenced by
 * treatmentPlanId (and clientId, denormalised for tenant-scoped queries).
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    treatmentPlanId: { type: String, required: true, index: true },
    clientId: { type: String, required: true },
    description: { type: String, required: true, trim: true },
    term: { type: String, enum: GOAL_TERM, default: 'SHORT_TERM' },
    priority: { type: Number, default: 3, min: 1, max: 5 },
    status: { type: String, enum: GOAL_STATUS, default: 'NOT_STARTED' },
    progress: { type: Number, default: 0, min: 0, max: 100 },
  },
  { timestamps: true, versionKey: false, collection: 'goal' },
);
schema.plugin(tenantPlugin);
attributionFields(schema, { softDelete: true });
schema.index({ tenantId: 1, treatmentPlanId: 1 });

export const Goal = mongoose.model('Goal', schema);
