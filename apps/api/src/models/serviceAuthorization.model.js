import mongoose from 'mongoose';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { newId } from '../utils/id.js';
import { SERVICE_AUTH_TYPE, SERVICE_AUTH_STATUS } from './enums.js';

/**
 * FBA/ABA service authorization (Phase 2). Independent of the insurance
 * unit-authorization model: this records the administrative approval workflow
 * (NOT_SENT → SENT → APPROVED/DENIED) for a child's FBA and ABA service lines.
 * Multiple records per child are allowed; status transitions are guarded in the
 * service and every change appends to the append-only `history` array.
 */
const historySchema = new mongoose.Schema(
  {
    from: { type: String, enum: SERVICE_AUTH_STATUS, required: true },
    to: { type: String, enum: SERVICE_AUTH_STATUS, required: true },
    actorUserId: { type: String, default: null },
    reason: { type: String, default: null },
    at: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    clientId: { type: String, required: true, index: true },
    serviceType: { type: String, enum: SERVICE_AUTH_TYPE, required: true },
    status: { type: String, enum: SERVICE_AUTH_STATUS, default: 'NOT_SENT', index: true },
    authorizationNumber: { type: String, default: null, trim: true },
    billingCode: { type: String, default: null, trim: true },
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    units: { type: Number, default: null, min: 0 },
    // Booking burn-down: an APPROVED ABA/FBA authorization is bookable by
    // Scheduling (unified source), and appointments decrement usedUnits against
    // its `units`. Kept here (not a separate model) so the same authorization the
    // Company approves is the one scheduling consumes.
    usedUnits: { type: Number, default: 0, min: 0 },
    hours: { type: Number, default: null, min: 0 },
    unitPrice: { type: Number, default: null, min: 0 },
    comments: { type: String, default: null },
    history: { type: [historySchema], default: [] },
    // Soft-delete: archiving one authorization must never touch the child's other
    // authorizations or destroy history (spec Fix 1). Archived rows are excluded
    // from lists and scheduling but retained.
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true, optimisticConcurrency: true, versionKey: 'version' },
);

// Duplicate protection by REAL identity — the authorization number.
// Multiple authorizations per child are allowed (a child can hold several ABA
// and/or FBA authorizations over different periods/payers). Duplicate protection
// is by REAL identity — the authorization number — enforced only when a number is
// present, so number-less drafts don't collide. (Previously a unique index on
// (tenant, client, serviceType) wrongly capped it at one ABA + one FBA per child.)
schema.index(
  { tenantId: 1, clientId: 1, authorizationNumber: 1 },
  { unique: true, partialFilterExpression: { authorizationNumber: { $type: 'string' } } },
);
schema.index({ tenantId: 1, clientId: 1, serviceType: 1 });
schema.index({ tenantId: 1, clientId: 1, status: 1 });
// Company dashboard "Authorizations expiring soon": end dates in a window.
schema.index({ tenantId: 1, endDate: 1 });
schema.plugin(tenantPlugin);

export const ServiceAuthorization =
  mongoose.models.ServiceAuthorization || mongoose.model('ServiceAuthorization', schema);
