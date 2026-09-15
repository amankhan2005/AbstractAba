import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';

/**
 * A program within a goal — the teaching definition: instructions, teaching
 * procedure, reinforcement strategy, prompt hierarchy, and measurement method.
 * Tenant-owned, versioned. Referenced by goalId (and treatmentPlanId,
 * denormalised so a plan's whole tree can be scoped per tenant).
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    goalId: { type: String, required: true, index: true },
    treatmentPlanId: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    instructions: { type: String, default: null },
    teachingProcedure: { type: String, default: null },
    reinforcementStrategy: { type: String, default: null },
    promptHierarchy: { type: [String], default: [] },
    measurementMethod: { type: String, default: null },
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'program' },
);
schema.plugin(tenantPlugin);
attributionFields(schema, { softDelete: true });
schema.index({ tenantId: 1, goalId: 1 });
schema.index({ tenantId: 1, treatmentPlanId: 1 });

export const Program = mongoose.model('Program', schema);
