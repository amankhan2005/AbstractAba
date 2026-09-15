import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { CLIENT_STATUS, INTAKE_WORKFLOW_STATUS } from './enums.js';

/**
 * The person receiving ABA therapy — the first PHI-bearing entity and the root
 * every clinical record references. Tenant-owned (RLS → tenant plugin).
 *
 * PHI handling: identifying fields (name, dateOfBirth, contact, address) are
 * stored in the clear, protected by tenant isolation + RBAC + transport
 * security, so they stay queryable for lists and scheduling. The most sensitive
 * identifiers live in `sensitive`, sealed at rest through the PHI seam
 * (utils/phi.js) and never returned in list responses.
 */
const addressSchema = new mongoose.Schema(
  {
    line1: { type: String, default: null },
    line2: { type: String, default: null },
    city: { type: String, default: null },
    state: { type: String, default: null },
    postalCode: { type: String, default: null },
    country: { type: String, default: null },
  },
  { _id: false },
);

const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    clientNumber: { type: String, required: true },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    middleName: { type: String, default: null, trim: true },
    preferredName: { type: String, default: null, trim: true },
    dateOfBirth: { type: Date, default: null },
    sexAtBirth: { type: String, default: null },
    pronouns: { type: String, default: null },
    status: { type: String, enum: CLIENT_STATUS, default: 'REFERRED', index: true },
    intakeWorkflowStatus: { type: String, enum: INTAKE_WORKFLOW_STATUS, default: 'NOT_SENT', index: true },
    approvedWeeklyHours: { type: Number, default: null, min: 0 },
    primaryLanguage: { type: String, default: null },
    email: { type: String, default: null, trim: true, lowercase: true },
    phone: { type: String, default: null, trim: true },
    address: { type: addressSchema, default: null },
    // Sealed PHI envelope. Stored values are ciphertext produced by sealPhi();
    // there is no index or search over these fields by design.
    sensitive: {
      ssn: { type: String, default: null },
    },
    primaryGuardianId: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'client' },
);
schema.plugin(tenantPlugin);
attributionFields(schema, { softDelete: true });
schema.index({ tenantId: 1, clientNumber: 1 }, { unique: true });
schema.index({ tenantId: 1, status: 1 });
schema.index({ tenantId: 1, lastName: 1, firstName: 1 });

export const Client = mongoose.model('Client', schema);
