import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { PROVISIONING_STEP_STATE } from './enums.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';

/** One idempotent step of tenant provisioning. Organization-anchored, platform-scoped. */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    organizationId: { type: String, required: true },
    stepKey: { type: String, required: true },
    state: { type: String, enum: PROVISIONING_STEP_STATE, default: 'PENDING' },
    attempts: { type: Number, default: 0 },
    detail: { type: String, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'provisioning_step' },
);
schema.index({ organizationId: 1, stepKey: 1 }, { unique: true });
schema.index({ organizationId: 1, state: 1 });

schema.plugin(tenantPlugin);

export const ProvisioningStep = mongoose.model('ProvisioningStep', schema);
