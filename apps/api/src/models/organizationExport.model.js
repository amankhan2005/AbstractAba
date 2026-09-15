import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { EXPORT_STATE } from './enums.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';

/** Tenant data export produced during offboarding. Precondition to destruction. */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    organizationId: { type: String, required: true },
    state: { type: String, enum: EXPORT_STATE, default: 'REQUESTED' },
    requestedByUserId: { type: String, required: true },
    requestedAt: { type: Date, default: Date.now },
    artifactRef: { type: String, default: null },
    sizeBytes: { type: Number, default: null },
    checksum: { type: String, default: null },
    availableAt: { type: Date, default: null },
    downloadedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    failure: { type: String, default: null },
  },
  { versionKey: false, collection: 'organization_export' },
);
schema.index({ organizationId: 1, state: 1 });

schema.plugin(tenantPlugin);

export const OrganizationExport = mongoose.model('OrganizationExport', schema);
