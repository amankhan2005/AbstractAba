import mongoose from 'mongoose';
import { newId } from '../utils/id.js';
import { tenantPlugin } from '../tenancy/tenantPlugin.js';
import { attributionFields } from '../tenancy/baseFields.js';
import { ERA_MATCH_STATUS } from './enums.js';

/**
 * One CLP (claim payment) record extracted from an 835, plus its match outcome.
 * Tenant-owned. Ambiguous/unmatched records enter the manual resolution
 * workflow. Money in integer minor units. Posting to a claim is idempotent via
 * postedPaymentId (set once a payment is posted).
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, default: newId },
    eraFileId: { type: String, required: true, index: true },
    payerControlNumber: { type: String, default: null, index: true },
    claimNumberRef: { type: String, default: null }, // CLP01 (patient control number = our claimNumber)
    chargeAmount: { type: Number, default: 0 }, // minor units (CLP03)
    paidAmount: { type: Number, default: 0 }, // minor units (CLP04)
    patientResponsibility: { type: Number, default: 0 }, // minor units (CLP05)
    claimStatusCode: { type: String, default: null }, // CLP02
    matchStatus: { type: String, enum: ERA_MATCH_STATUS, default: 'UNMATCHED', index: true },
    matchedClaimId: { type: String, default: null, index: true },
    candidateClaimIds: { type: [String], default: [] }, // when AMBIGUOUS
    postedPaymentId: { type: String, default: null }, // set once posted (idempotency)
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'era_claim_payment' },
);
schema.index({ organizationId: 1, matchStatus: 1 });
schema.plugin(tenantPlugin);
attributionFields(schema);

export const EraClaimPayment = mongoose.models.EraClaimPayment || mongoose.model('EraClaimPayment', schema);
