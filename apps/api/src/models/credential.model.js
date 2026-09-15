import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { CREDENTIAL_STATUS } from './enums.js';

/**
 * A professional credential held by a staff member (e.g. BCBA, RBT, CPR), with
 * an expiry the credential-expiry scan watches. Tenant-owned; referenced by
 * staffProfileId. The expiresDate index supports the scheduled scan that raises
 * the staff.credential_expiring notification.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    staffProfileId: { type: String, required: true, index: true },
    credentialType: { type: String, required: true, trim: true },
    number: { type: String, default: null, trim: true },
    issuingAuthority: { type: String, default: null, trim: true },
    issuedDate: { type: Date, default: null },
    expiresDate: { type: Date, default: null },
    status: { type: String, enum: CREDENTIAL_STATUS, default: 'ACTIVE' },
  },
  { timestamps: true, versionKey: false, collection: 'credential' },
);
schema.plugin(tenantPlugin);
attributionFields(schema, { softDelete: true });
schema.index({ tenantId: 1, staffProfileId: 1 });
schema.index({ tenantId: 1, expiresDate: 1 });

export const Credential = mongoose.model('Credential', schema);
