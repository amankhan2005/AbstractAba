import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { AGREEMENT_TYPE } from './enums.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';

/**
 * Executed agreement. Organization-anchored (keyed by organizationId), handled
 * during onboarding at platform scope before the tenant is active — platform-
 * scoped like the other onboarding collections. The BAA gates activation.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    organizationId: { type: String, required: true },
    type: { type: String, enum: AGREEMENT_TYPE, required: true },
    version: { type: String, required: true },
    executedByName: { type: String, required: true },
    executedByTitle: { type: String, required: true },
    executedAt: { type: Date, required: true },
    executedIp: { type: String, default: null },
    countersignedAt: { type: Date, default: null },
    countersignedByUserId: { type: String, default: null },
    documentRef: { type: String, default: null },
    createdBy: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false, collection: 'organization_agreement' },
);
schema.index({ organizationId: 1, type: 1, version: 1 }, { unique: true });
schema.index({ organizationId: 1, type: 1 });

schema.plugin(tenantPlugin);

export const OrganizationAgreement = mongoose.model('OrganizationAgreement', schema);
