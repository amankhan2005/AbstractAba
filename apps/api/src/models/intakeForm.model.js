import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { INTAKE_STATUS } from './enums.js';

/**
 * Intake / demographics captured at referral, one per client (unique on
 * clientId within the tenant). Tenant-owned. `presentingConcerns` is PHI free
 * text; the insurance member id is sealed at rest through the PHI seam
 * (utils/phi.js), so a leaked database yields no usable identifier.
 */
const insuranceSchema = new mongoose.Schema(
  {
    payerName: { type: String, default: null, trim: true },
    planName: { type: String, default: null, trim: true },
    // Ciphertext produced by sealPhi(); never indexed or searched.
    memberId: { type: String, default: null },
  },
  { _id: false },
);

const consentsSchema = new mongoose.Schema(
  {
    hipaaAcknowledged: { type: Boolean, default: false },
    treatmentConsent: { type: Boolean, default: false },
    consentedAt: { type: Date, default: null },
  },
  { _id: false },
);

const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    clientId: { type: String, required: true },
    referralSource: { type: String, default: null, trim: true },
    referralDate: { type: Date, default: null },
    presentingConcerns: { type: String, default: null },
    insurance: { type: insuranceSchema, default: () => ({}) },
    consents: { type: consentsSchema, default: () => ({}) },
    status: { type: String, enum: INTAKE_STATUS, default: 'DRAFT' },
  },
  { timestamps: true, versionKey: false, collection: 'intakeForm' },
);
schema.plugin(tenantPlugin);
attributionFields(schema, { softDelete: true });
schema.index({ tenantId: 1, clientId: 1 }, { unique: true });

export const IntakeForm = mongoose.model('IntakeForm', schema);
