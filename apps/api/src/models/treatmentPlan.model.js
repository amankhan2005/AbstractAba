import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { TREATMENT_PLAN_STATUS } from './enums.js';

/**
 * A treatment plan for one client, owned by one responsible BCBA. The
 * structured definition a session measures against: the plan holds goals, goals
 * hold programs, programs hold targets. Tenant-owned, versioned for optimistic
 * concurrency. Only ACTIVE clients may have a plan created; an ARCHIVED plan is
 * immutable (enforced in the service).
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    clientId: { type: String, required: true, index: true },
    title: { type: String, required: true, trim: true },
    responsibleBcbaStaffId: { type: String, required: true },
    status: { type: String, enum: TREATMENT_PLAN_STATUS, default: 'DRAFT', index: true },
    effectiveDate: { type: Date, default: null },
    reviewDate: { type: Date, default: null },
    notes: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'treatmentPlan' },
);
schema.plugin(tenantPlugin);
attributionFields(schema, { softDelete: true });
schema.index({ tenantId: 1, clientId: 1 });
schema.index({ tenantId: 1, clientId: 1, status: 1 });
schema.index({ tenantId: 1, responsibleBcbaStaffId: 1 });

export const TreatmentPlan = mongoose.model('TreatmentPlan', schema);
