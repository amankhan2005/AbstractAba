import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';

/**
 * A single service line on a claim, derived from one frozen session. Tenant-
 * owned. The unique (claimId is not enough) index on (tenantId, sessionId)
 * prevents the same session being claimed twice across the whole tenant.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    claimId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    serviceDate: { type: Date, required: true },
    staffProfileId: { type: String, default: null },
    serviceCode: { type: String, default: null, trim: true },
    units: { type: Number, required: true, min: 0 },
    charge: { type: Number, required: true, min: 0 }, // minor units
    authorizationId: { type: String, default: null },
    // Insurance billing basis for the line (additive): the clinician's role, the
    // actual worked minutes (SessionTimeRecord) and the hourly rate (cents) the
    // charge was computed from.
    role: { type: String, enum: ['BCBA', 'RBT', null], default: null },
    workedMinutes: { type: Number, default: null, min: 0 },
    hourlyRate: { type: Number, default: null, min: 0 },
  },
  { timestamps: true, versionKey: false, collection: 'claim_line' },
);
// A session can be claimed at most once per tenant.
schema.index({ tenantId: 1, sessionId: 1 }, { unique: true }); // tenantId is the field the tenant plugin stamps
schema.plugin(tenantPlugin);
attributionFields(schema);

export const ClaimLine = mongoose.models.ClaimLine || mongoose.model('ClaimLine', schema);
