import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { TARGET_MEASUREMENT_TYPE, TARGET_STATUS } from './enums.js';

/**
 * A target within a program — the concrete, measurable unit a session collects
 * data against: a baseline, mastery criteria, current progress, a measurement
 * type, and active/inactive status. Tenant-owned, versioned. Referenced by
 * programId (and treatmentPlanId, denormalised for tenant-scoped tree queries).
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    programId: { type: String, required: true, index: true },
    treatmentPlanId: { type: String, required: true },
    label: { type: String, required: true, trim: true },
    measurementType: { type: String, enum: TARGET_MEASUREMENT_TYPE, default: 'PERCENT_CORRECT' },
    baseline: { type: String, default: null },
    masteryCriteria: { type: String, default: null },
    currentProgress: { type: Number, default: 0, min: 0, max: 100 },
    status: { type: String, enum: TARGET_STATUS, default: 'ACTIVE' },
    // Weekly therapy focus (BCBA-set): whether this target is part of the child's
    // current week's plan, plus optional week-specific instructions for the RBT.
    weeklyFocus: { type: Boolean, default: false },
    weeklyInstructions: { type: String, default: null },
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'target' },
);
schema.plugin(tenantPlugin);
attributionFields(schema, { softDelete: true });
schema.index({ tenantId: 1, programId: 1 });
schema.index({ tenantId: 1, treatmentPlanId: 1 });

export const Target = mongoose.model('Target', schema);
