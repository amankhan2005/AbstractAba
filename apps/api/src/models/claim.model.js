import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { CLAIM_STATUS, CLAIM_RECONCILIATION_STATUS } from './enums.js';

/**
 * A payer claim generated from frozen sessions within an authorization.
 * Tenant-owned. Money is integer minor units (cents); totals are computed
 * server-side from claim lines and never trusted from the client. Clinical
 * source data (session/authorization/client) is referenced, not duplicated.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    claimNumber: { type: String, required: true },
    clientId: { type: String, required: true, index: true },
    payerName: { type: String, default: null, trim: true },
    authorizationId: { type: String, default: null, index: true },
    payerControlNumber: { type: String, default: null }, // assigned by payer (from ERA)
    servicePeriodStart: { type: Date, default: null },
    servicePeriodEnd: { type: Date, default: null },
    totalUnits: { type: Number, default: 0, min: 0 },
    totalCharge: { type: Number, default: 0, min: 0 }, // minor units
    status: { type: String, enum: CLAIM_STATUS, default: 'DRAFT', index: true },
    reconciliationStatus: { type: String, enum: CLAIM_RECONCILIATION_STATUS, default: 'UNRECONCILED', index: true },
    paidAmount: { type: Number, default: 0, min: 0 },
    adjustmentAmount: { type: Number, default: 0, min: 0 },
    submittedAt: { type: Date, default: null },
    submittedBy: { type: String, default: null },
    rejectionReason: { type: String, default: null },
    denialReason: { type: String, default: null },
    // The billing period (organization business dates, YYYY-MM-DD, inclusive)
    // this claim was generated for — how a generated bill is listed and reopened.
    billingPeriodStart: { type: String, default: null },
    billingPeriodEnd: { type: String, default: null },
    // Idempotency guard for generate-from-sessions.
    generationKey: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'claim' },
);
// Keyed on `tenantId` — the field the tenant plugin actually stamps. These were
// declared on `organizationId`, which a claim never carries, so every "per
// organization" unique index was really GLOBAL: a second organization's first
// claim of the month collided on claim number with the first organization's.
schema.index({ tenantId: 1, status: 1 });
schema.index({ tenantId: 1, createdAt: -1 });
schema.index({ tenantId: 1, claimNumber: 1 }, { unique: true });
schema.index({ tenantId: 1, generationKey: 1 }, { unique: true, partialFilterExpression: { generationKey: { $type: 'string' } } });
schema.index({ tenantId: 1, billingPeriodStart: 1, billingPeriodEnd: 1 }, { partialFilterExpression: { billingPeriodStart: { $type: 'string' } } });
schema.index({ tenantId: 1, payerControlNumber: 1 }, { partialFilterExpression: { payerControlNumber: { $type: 'string' } } });
schema.plugin(tenantPlugin);
attributionFields(schema);

export const Claim = mongoose.models.Claim || mongoose.model('Claim', schema);
