import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { GUARDIAN_RELATIONSHIP } from './enums.js';

/**
 * A guardian legally or practically responsible for a client (parent, legal
 * guardian, caregiver). A separate tenant-owned collection referenced by
 * clientId — kept independent of the client document so scheduling and billing
 * can reference guardians directly in later phases. At most one guardian per
 * client carries isPrimary (enforced in the service).
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
    clientId: { type: String, required: true, index: true },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    relationship: { type: String, enum: GUARDIAN_RELATIONSHIP, default: 'PARENT' },
    isPrimary: { type: Boolean, default: false },
    phone: { type: String, default: null, trim: true },
    email: { type: String, default: null, trim: true, lowercase: true },
    address: { type: addressSchema, default: null },
    notes: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'guardian' },
);
schema.plugin(tenantPlugin);
attributionFields(schema, { softDelete: true });
schema.index({ tenantId: 1, clientId: 1 });
schema.index({ tenantId: 1, clientId: 1, isPrimary: 1 });

export const Guardian = mongoose.model('Guardian', schema);
